// DOM integration tests exercise the real client and API, without camera/printer hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fixture,tour,issue,scan } from './helpers.js';
const html=readFileSync('public/index.html','utf8'),js=readFileSync('public/app.js','utf8');
async function waitFor(fn){for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('UI condition timed out');}
// signedIn:false sends every request without a session, as a gate phone does.
function domFor(f,path='/',{signedIn=true}={}){
 const dom=new JSDOM(html,{url:'http://localhost:3000'+path,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;
 w.Date=class extends Date{constructor(...args){super(...(args.length?args:[f.getTime()]));}};
 w.fetch=async(url,options={})=>{
  const path=new URL(url,w.location.href).pathname+new URL(url,w.location.href).search;
  const agent=!signedIn||path.startsWith('/api/scan')||path==='/api/service'?f.scanner:f.admin;
  let req=options.method==='POST'?agent.post(path):agent.get(path);
  if(options.headers?.['Content-Type']==='application/pdf')req=req.set('Content-Type','application/pdf').send(Buffer.from(await options.body.arrayBuffer()));
  else if(options.body)req=req.send(JSON.parse(options.body));
  const result=await req;
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body,arrayBuffer:async()=>result.body};
 };
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 w.eval(js);return dom;
}
function submit(w,form,button){form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}));}
const karbalaToday=()=> '2026-10-21';
// The Tours page opens on today's arrivals; once its first load has finished, clear the date to list every tour.
async function allDates(w,d){
 await waitFor(()=>d.querySelector('#tourCount')&&d.querySelector('#tourCount').textContent!=='Loading…');
 assert.equal(d.querySelector('[name=arrival]').value,karbalaToday());
 d.querySelector('[name=arrival]').value='';submit(w,d.querySelector('#tourFilters'));
}

test('tours: arrival filter, select all, print job saved despite printer unavailable, replacement selection',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,2),future=await tour(f,1,{arrival:'2026-11-01',departure:'2026-11-02'});
 dom=domFor(f);const w=dom.window,d=w.document;
 await allDates(w,d);
 await waitFor(()=>d.querySelectorAll('.tour-check').length===2);
 d.querySelector('[name=arrival]').value='2026-10-21';submit(w,d.querySelector('#tourFilters'));
 await waitFor(()=>d.querySelectorAll('.tour-check').length===1);
 const all=d.querySelector('#allTours');all.checked=true;all.dispatchEvent(new w.Event('change'));assert.equal(d.querySelector('#printSelected').disabled,false);
 d.querySelector('#printSelected').click();
 await waitFor(()=>f.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n===1);
 await waitFor(()=>d.querySelector('.replace')?.disabled===false);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,2);
 assert.ok(d.querySelector('a[href$="/pdf"]'));assert.match(d.querySelector('#notice').textContent,/PDF saved/);
 d.querySelector('.replace').click();await waitFor(()=>d.querySelector('#peopleDialog').hasAttribute('open'));
 assert.equal(d.querySelectorAll('#peopleContent input').length,2);
 d.querySelector('#peopleContent input').checked=true;d.querySelector('#replaceSelected').click();
 await waitFor(()=>f.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n===2);
 await waitFor(()=>!d.querySelector('#peopleDialog').hasAttribute('open'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,2);
 }finally{dom?.window.close();f.close();}
});

test('add tour submit persists to API; text from source is escaped; settings save schedule',async()=>{
 const f=await fixture();let dom;try{
 dom=domFor(f,'/#generate');const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('#addTour'));
 const form=d.querySelector('#addTour');
 assert.equal(form.querySelector('[name=tour_id]').required,false);assert.equal(form.querySelector('[name=its]').required,false);
 for(const [key,value]of Object.entries({office:'<script>globalThis.bad=true</script>',its:'30412345',arrival:'2026-10-21',departure:'2026-10-22',pax:'3'}))form.querySelector(`[name=${key}]`).value=value;
 submit(w,form,form.querySelector('[value=save]'));
 await waitFor(()=>d.querySelectorAll('.tour-check').length===1);
 assert.ok(d.querySelector('#tourTable').textContent.includes('<script>'));assert.equal(w.bad,undefined);assert.equal(d.querySelector('#tourTable script'),null);
 assert.match(d.querySelector('#tourTable tbody').textContent,/30412345/);assert.equal(f.db.prepare('SELECT tour_id FROM tours').get().tour_id,null);
 w.location.hash='settings';await waitFor(()=>d.querySelector('#sourceSettings'));
 d.querySelector('[name=dailyTimes]').value='06:00, 12:00';submit(w,d.querySelector('#sourceSettings'));
 await waitFor(()=>{const row=f.db.prepare("SELECT value FROM settings WHERE key='source'").get();return row&&JSON.parse(row.value).dailyTimes?.length===2;});
 d.querySelector('#requestSync').click();await waitFor(()=>f.db.prepare("SELECT value FROM settings WHERE key='syncRequestedAt'").get());
 await waitFor(()=>d.querySelector('#notice').textContent.includes('Sync requested'));
 }finally{dom?.window.close();f.close();}
});

test('signed out, / asks for the administrator password only',async()=>{
 const f=await fixture();let dom;try{
 dom=domFor(f,'/',{signedIn:false});const d=dom.window.document;
 await waitFor(()=>d.querySelector('#loginForm'));
 assert.equal(d.querySelector('#loginForm select'),null);assert.match(d.querySelector('#loginForm').textContent,/Administrator password/);
 }finally{dom?.window.close();f.close();}
});
test('scanner: valid QR green once per meal, unknown red, no yellow state',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);f.setTime('2026-10-21T04:00:00Z');// Breakfast in Karbala.
 dom=domFor(f,'/scanner',{signedIn:false});const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('#scanResult')?.textContent.includes('Ready to scan'));
 assert.equal(d.querySelector('#loginForm'),null);assert.doesNotMatch(d.body.textContent,/Sign (in|out)|Back to printing system/);
 assert.equal(d.querySelector('#manualSubmit').disabled,false);assert.equal(d.querySelector('.meal-strip'),null);assert.match(d.querySelector('#scanResult').textContent,/Breakfast/);
 const form=d.querySelector('#manualScan'),input=d.querySelector('#manualCode');
 input.value=`MW1:${cards[0].token}`;submit(w,form);await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 assert.equal(d.querySelector('#scanResult strong').textContent,'ALLOW');
 await new Promise(r=>setTimeout(r,3100));d.querySelector('#scanResult').className='scan-result';input.value=`MW1:${cards[0].token}`;submit(w,form);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('red'));assert.match(d.querySelector('#scanResult').textContent,/Already admitted/);
 await new Promise(r=>setTimeout(r,1400));input.value='MW1:unknown';submit(w,form);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('red'));assert.match(d.querySelector('#scanResult').textContent,/not recognised/);
 assert.equal(d.querySelector('[class*=yellow]'),null);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE reason='admitted'").get().n,1);
 }finally{dom?.window.close();f.close();}
});

test('scanner camera checks cards during meals and toggles on and off',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);f.setTime('2026-10-21T16:30:00Z');// Dinner in Karbala.
 dom=new JSDOM(html,{url:'https://localhost:3000/scanner',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document;let decode,stopped=0;
 w.fetch=async(url,options={})=>{const path=new URL(url,w.location.href).pathname+new URL(url,w.location.href).search;let req=options.method==='POST'?f.scanner.post(path):f.scanner.get(path);if(options.body)req=req.send(JSON.parse(options.body));const r=await req;return{ok:r.status<300,status:r.status,json:async()=>r.body};};
 Object.defineProperty(w,'isSecureContext',{value:true});// jsdom does not implement secure contexts.
 w.MawaidCamera=class{async start(camera,config,onDecode){decode=onDecode;}async stop(){stopped++;}clear(){}};
 w.eval(js);
 await waitFor(()=>d.querySelector('#scanResult')?.textContent.includes('Ready to scan'));
 const button=d.querySelector('#startCamera');
 button.click();await waitFor(()=>button.textContent==='Stop camera');
 decode(`MW1:${cards[0].token}`);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,1);
 button.click();await waitFor(()=>button.textContent==='Start camera');assert.equal(stopped,1);
 }finally{dom?.window.close();f.close();}
});

test('Safari: added without any required field, saved in Print log and printed without a QR code',async()=>{
 const f=await fixture();let dom;try{
 dom=domFor(f,'/#generate');const w=dom.window,d=w.document,printed=[];
 w.generateSafariPdf=async(safaris,settings)=>{printed.push({safaris,settings});return new w.Blob(['%PDF-test\n%%EOF\n']);};
 const append=d.head.appendChild.bind(d.head);
 d.head.appendChild=element=>{const result=append(element);if(element.src?.endsWith('/vendor/pdf.js'))queueMicrotask(()=>element.onload());return result;};
 await waitFor(()=>d.querySelector('#addSafari'));
 const form=d.querySelector('#addSafari');
 for(const [key,value]of Object.entries({office:'Izan Caravan',arrival:'2026-10-21',departure:'2026-10-24',pax:'12'}))form.querySelector(`[name=${key}]`).value=value;
 submit(w,form,form.querySelector('[value=print]'));
 await waitFor(()=>printed.length===1);await allDates(w,d);await waitFor(()=>d.querySelector('.safari-check'));
 const [card]=printed[0].safaris;assert.deepEqual([card.office,card.arrival,card.departure,card.pax],['Izan Caravan','2026-10-21','2026-10-24',12]);
 assert.equal(printed[0].settings.widthMm,76.2);
 // No QR Tray here: the PDF is still saved in Print log, no QR cards are issued, and the notice says what to do.
 await waitFor(()=>/PDF saved in Print log\. The printer library did not load/.test(d.querySelector('#notice').textContent));
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE kind='safari' AND pdf IS NOT NULL").get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cards').get().n,0);
 assert.equal(f.db.prepare("SELECT printer_status FROM batches").get().printer_status,'printer_error');
 const row=d.querySelector('.safari-check').closest('tr');assert.match(row.textContent,/Safari/);assert.match(row.textContent,/Izan Caravan/);assert.ok(row.querySelector('a[href$="/pdf"]'),'View PDF link on the Safari row');
 row.querySelector('.print-safari').click();await waitFor(()=>printed.length===2);assert.equal(printed[1].safaris[0].office,'Izan Caravan');
 await waitFor(()=>f.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n===2);
 // Selecting a Safari card and a tour prints the sticker and the tour's QR cards.
 await tour(f,1);d.querySelector('#tourFilters').dispatchEvent(new w.Event('submit',{cancelable:true}));
 await waitFor(()=>d.querySelector('.tour-check'));
 const all=d.querySelector('#allTours');all.checked=true;all.dispatchEvent(new w.Event('change'));assert.equal(d.querySelector('.safari-check').checked,false);
 d.querySelector('.safari-check').checked=true;d.querySelector('.safari-check').dispatchEvent(new w.Event('change'));d.querySelector('#printSelected').click();
 await waitFor(()=>printed.length===3&&f.db.prepare('SELECT COUNT(*) AS n FROM batches').get().n===4);
 w.location.hash='prints';await waitFor(()=>/Safari stickers/.test(d.querySelector('#main table')?.textContent||''));
 assert.equal([...d.querySelectorAll('#main tbody tr')].filter(r=>/Safari stickers/.test(r.textContent)).length,3);
 // An entirely blank Safari card is allowed.
 w.location.hash='generate';await waitFor(()=>d.querySelector('#addSafari'));
 submit(w,d.querySelector('#addSafari'),d.querySelector('#addSafari [value=save]'));
 await waitFor(()=>d.querySelector('#tourFilters'));await allDates(w,d);
 await waitFor(()=>d.querySelectorAll('.safari-check').length===2);
 }finally{dom?.window.close();f.close();}
});

function fakeFolder(name){
 const dirs=new Map(),files=new Map();
 return {name,kind:'directory',dirs,files,
  async getDirectoryHandle(n,{create}={}){if(!dirs.has(n)){if(!create)throw Object.assign(new Error('Not found'),{name:'NotFoundError'});dirs.set(n,fakeFolder(n));}return dirs.get(n);},
  async getFileHandle(n){return{async createWritable(){let data='';return{async write(d){data+=d;},async close(){files.set(n,data);}};}};},
  async queryPermission(){return 'granted';},async requestPermission(){return 'granted';}};
}
async function archiveFixture(){
 const f=await fixture();const t=await tour(f,2),{cards}=await issue(f,t.id);
 await scan(f,cards[0].token);
 await scan(f,'=HYPERLINK("bad")');f.setTime('2026-10-22T04:00:00Z');await scan(f,cards[1].token);
 return f;
}
async function startArchive(w,d){
 await waitFor(()=>d.querySelector('#readyList b'));
 const input=d.querySelector('#clearForm [name=before]');input.value='2026-10-22';input.dispatchEvent(new w.Event('change'));
 await waitFor(()=>d.querySelector('#readyList b')?.textContent==='2');
 submit(w,d.querySelector('#clearForm'),d.querySelector('#archiveClear'));
 await waitFor(()=>/Archived and cleared/.test(d.querySelector('#archiveProgress').textContent));
}

test('archive & clear saves CSV folders inside Mawaid Archive, then clears only older records',async()=>{
 const f=await archiveFixture();let dom;try{
 dom=domFor(f,'/#settings');const w=dom.window,d=w.document,documents=fakeFolder('Documents');let picks=0;
 w.showDirectoryPicker=async()=>{picks++;return documents;};
 await startArchive(w,d);
 const root=documents.dirs.get('Mawaid Archive');assert.ok(root);assert.equal(root.dirs.size,1);
 const [name,archive]=[...root.dirs][0];assert.match(name,/^Archive \d{4}-\d{2}-\d{2} \d{2}\.\d{2}$/);
 assert.deepEqual([...archive.files.keys()].sort(),['cards.csv','daily-meal-summary.csv','extensions.csv','meals-served.csv','print-log.csv','read-me.txt','scan-log.csv','tours.csv']);
 const scans=archive.files.get('scan-log.csv');assert.match(scans,/26\/3205,FH Kuwait,1,Admitted,admitted/);assert.match(scans,/Declined,unknown card/);
 assert.match(archive.files.get('daily-meal-summary.csv'),/2026-10-21,26\/3205,FH Kuwait,2,1,0,0/);
 assert.ok(![...archive.files.keys()].some(n=>n.endsWith('.pdf')));
 assert.match(d.querySelector('#archiveProgress').textContent,/2 scan records, 1 meals served/);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE date<'2026-10-22'").get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,1);
 // A second archive in the same minute gets its own folder.
 await waitFor(()=>!d.querySelector('#archiveClear').disabled);
 submit(w,d.querySelector('#clearForm'),d.querySelector('#archiveClear'));
 await waitFor(()=>root.dirs.size===2);assert.ok([...root.dirs.keys()].some(n=>n.endsWith('(2)')));
 }finally{dom?.window.close();f.close();}
});

test('archive downloads a zip where folders are unavailable; delete asks before removing records',async()=>{
 const f=await archiveFixture();let dom;try{
 dom=domFor(f,'/#settings');const w=dom.window,d=w.document;let blob;
 w.URL.createObjectURL=b=>{blob=b;return 'blob:test';};w.URL.revokeObjectURL=()=>{};
 await waitFor(()=>/zip/.test(d.querySelector('#folderLine')?.textContent));
 await startArchive(w,d);
 const bytes=Buffer.from(await blob.arrayBuffer()),text=bytes.toString('latin1');
 assert.equal(text.slice(0,2),'PK');assert.match(text,/Mawaid Archive\/Archive [^/]+\/scan-log\.csv/);assert.match(text,/'=HYPERLINK|unknown card/);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,1);
 f.setTime('2026-10-23T04:00:00Z');
 const input=d.querySelector('#clearForm [name=before]');input.value='2026-10-23';input.dispatchEvent(new w.Event('change'));
 await waitFor(()=>!d.querySelector('#deleteRecords').disabled&&d.querySelector('#readyList b')?.textContent==='1');
 d.querySelector('#deleteRecords').click();await waitFor(()=>d.querySelector('#confirmDelete'));
 d.querySelector('#cancelDelete').click();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,1);
 d.querySelector('#deleteRecords').click();await waitFor(()=>d.querySelector('#confirmDelete'));d.querySelector('#confirmDelete').click();
 await waitFor(()=>/^Deleted 1 scan records/.test(d.querySelector('#archiveProgress').textContent));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,0);
 }finally{dom?.window.close();f.close();}
});

test('tours: Show and Sort by dropdowns reload the list; Safari cards sort alongside tours',async()=>{
 const f=await fixture();let dom;try{
 const done=await tour(f,1,{tour_id:'26/9',arrival:'2026-10-21',departure:'2026-10-22'});
 await tour(f,2,{tour_id:'26/10',arrival:'2026-10-25',departure:'2026-10-27'});await tour(f,1,{tour_id:'26/100',arrival:'2026-11-02',departure:'2026-11-04'});
 await f.admin.post('/api/safaris').send({tour_id:'26/50',office:'Izan Caravan',arrival:'2026-10-30',departure:'2026-11-01'}).expect(201);
 await issue(f,done.id);
 dom=domFor(f);const w=dom.window,d=w.document,order=()=>[...d.querySelectorAll('#tourTable tbody tr td:nth-child(2) strong')].map(s=>s.textContent).join(' ');
 await allDates(w,d);
 await waitFor(()=>order()==='26/100 26/50 26/10 26/9');
 const pick=(name,value)=>{const s=d.querySelector(`[name=${name}]`);s.value=value;s.dispatchEvent(new w.Event('change'));};
 pick('sort','tour');await waitFor(()=>order()==='26/9 26/10 26/50 26/100');
 pick('sort','oldest');await waitFor(()=>order()==='26/9 26/10 26/50 26/100');
 pick('status','printed');await waitFor(()=>order()==='26/9');
 pick('status','unprinted');await waitFor(()=>order()==='26/10 26/50 26/100');
 d.querySelector('[name=q]').value='nothing like this';submit(w,d.querySelector('#tourFilters'));
 await waitFor(()=>/No tours match/.test(d.querySelector('#tourTable').textContent));
 // Reset returns to the defaults: today's arrivals, newest first.
 d.querySelector('#tourFilters').reset();
 assert.equal(d.querySelector('[name=arrival]').value,karbalaToday());assert.equal(d.querySelector('[name=sort]').value,'newest');
 await allDates(w,d);await waitFor(()=>order()==='26/100 26/50 26/10 26/9');
 }finally{dom?.window.close();f.close();}
});

test('daily summary shows each meal and total; scanner status pauses in hidden tabs',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);
 for(const time of ['2026-10-21T04:00:00Z','2026-10-21T09:00:00Z','2026-10-21T16:30:00Z']){f.setTime(time);await scan(f,cards[0].token);}
 dom=domFor(f,'/#summary');const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('[data-count=dinner]'));
 for(const meal of ['breakfast','lunch','dinner'])assert.equal(d.querySelector(`[data-count=${meal}]`).textContent,'1');
 assert.equal(d.querySelector('[data-count=scans]').textContent,'3');assert.doesNotMatch(d.querySelector('#summaryContent').textContent,/people staying|tour/i);
 dom.window.close();dom=undefined;
 // Capture the timer callback instead of waiting a minute.
 dom=new JSDOM(html,{url:'http://localhost:3000/scanner',runScripts:'outside-only',pretendToBeVisual:true});
 const phone=dom.window;let tick,interval,statusRequests=0,hidden=false;
 Object.defineProperty(phone.document,'hidden',{get:()=>hidden});
 phone.setInterval=(fn,ms)=>{tick=fn;interval=ms;return 1;};phone.clearInterval=()=>{};
 phone.fetch=async(url)=>{if(url.startsWith('/api/scanner/data'))statusRequests++;return{ok:true,json:async()=>({date:'2026-10-21',meal:'dinner',mealLabel:'Dinner'})};};
 phone.eval(js);await waitFor(()=>tick);assert.equal(interval,60000);assert.equal(statusRequests,1);
 hidden=true;await tick();assert.equal(statusRequests,1);
 hidden=false;phone.document.dispatchEvent(new phone.Event('visibilitychange'));await waitFor(()=>statusRequests===2);
 }finally{dom?.window.close();f.close();}
});

test('tours: Extend adds lunch or a whole day on the same cards, shows it on the row and keeps history',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,2);await issue(f,t.id);
 dom=domFor(f);const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('.extend'));
 d.querySelector('.extend').click();await waitFor(()=>d.querySelector('#extendDate'));
 assert.ok(d.querySelector('#peopleDialog').hasAttribute('open'));assert.equal(d.querySelector('#extendDate').value,'2026-10-24');
 assert.match(d.querySelector('#peopleContent').textContent,/nothing new to print/);
 d.querySelector('[data-meals=lunch]').click();
 await waitFor(()=>d.querySelector('.remove-extension'));
 assert.deepEqual(f.db.prepare('SELECT date,meals FROM tour_extensions').all().map(r=>({...r})),[{date:'2026-10-24',meals:'lunch'}]);
 await waitFor(()=>/\+ Sat 24 Oct · Lunch/.test(d.querySelector('#tourTable').textContent));
 d.querySelector('[data-meals=day]').click();
 await waitFor(()=>d.querySelectorAll('.extension-list li').length===2);
 assert.match(d.querySelector('.extension-list li.removed').textContent,/Lunch only/);
 await waitFor(()=>/\+ Sat 24 Oct · All day/.test(d.querySelector('#tourTable').textContent));
 d.querySelector('.remove-extension').click();await waitFor(()=>!d.querySelector('.remove-extension'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM tour_extensions WHERE removed_at IS NULL').get().n,0);
 }finally{dom?.window.close();f.close();}
});

test('scanner keeps checking cards offline with a full-screen result, then sends the scans when back online',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,2),{cards}=await issue(f,t.id);f.setTime('2026-10-21T04:00:00Z');
 dom=domFor(f,'/scanner',{signedIn:false});const w=dom.window,d=w.document,online=w.fetch;let offline=false;
 Object.defineProperty(w.crypto,'subtle',{value:globalThis.crypto.subtle});w.TextEncoder=TextEncoder;
 w.fetch=async(url,options)=>{if(offline)throw new TypeError('Failed to fetch');return online(url,options);};
 await waitFor(()=>d.querySelector('#scanResult')?.textContent.includes('Ready to scan'));
 assert.match(d.querySelector('#scannerStatus').textContent,/2 cards on this phone/);assert.equal(d.querySelector('#linkChip').textContent,'Online');
 const form=d.querySelector('#manualScan'),input=d.querySelector('#manualCode'),send=code=>{input.value=code;submit(w,form);};
 offline=true;send(`MW1:${cards[0].token}`);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 assert.equal(d.querySelector('#flash').hidden,false);assert.equal(d.querySelector('#flash').className,'flash green');
 assert.match(d.querySelector('#scanResult').textContent,/Checked offline/);assert.equal(d.querySelector('#linkChip').textContent,'Offline');
 await new Promise(r=>setTimeout(r,3100));send(`MW1:${cards[0].token}`);
 await waitFor(()=>d.querySelector('#scanResult strong').textContent==='ALREADY SCANNED');
 assert.equal(d.querySelector('#flash').className,'flash red');assert.match(d.querySelector('#scanResult').textContent,/at 7:00 am/);
 await new Promise(r=>setTimeout(r,1400));send('MW1:unknown');
 await waitFor(()=>/not on this phone/.test(d.querySelector('#scanResult').textContent));
 assert.equal(JSON.parse(w.localStorage.getItem('mawaidScanQueue')).length,3);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,0);
 // Back online: the next status check sends the queued scans, oldest first.
 offline=false;d.dispatchEvent(new w.Event('visibilitychange'));
 await waitFor(()=>JSON.parse(w.localStorage.getItem('mawaidScanQueue')).length===0);
 assert.deepEqual(f.db.prepare('SELECT reason,offline FROM scan_logs ORDER BY id').all().map(r=>[r.reason,r.offline]),[['admitted',1],['already_scanned',1],['unknown_card',1]]);
 await waitFor(()=>d.querySelector('#linkChip').textContent==='Online');
 // Online again, a duplicate is still caught by the server.
 await new Promise(r=>setTimeout(r,1400));send(`MW1:${cards[0].token}`);
 await waitFor(()=>/Already admitted/.test(d.querySelector('#scanResult').textContent)&&!/offline/.test(d.querySelector('#scanResult').textContent));
 }finally{dom?.window.close();f.close();}
});
