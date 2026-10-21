// DOM integration tests exercise the real client and API, without camera/printer hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fixture,tour,issue,scan } from './helpers.js';
const html=readFileSync('public/index.html','utf8'),js=readFileSync('public/app.js','utf8');
async function waitFor(fn){for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('UI condition timed out');}
function domFor(f,path='/'){
 const dom=new JSDOM(html,{url:'http://localhost:3000'+path,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;
 w.fetch=async(url,options={})=>{
  const path=new URL(url,w.location.href).pathname+new URL(url,w.location.href).search;
  const agent=path.startsWith('/api/scan')||path==='/api/service'?f.scanner:f.admin;
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

test('tours: arrival filter, select all, print job saved despite printer unavailable, replacement selection',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,2),future=await tour(f,1,{arrival:'2026-11-01',departure:'2026-11-02'});
 dom=domFor(f);const w=dom.window,d=w.document;
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

test('scanner: valid QR green on every scan at any hour, unknown red, no yellow state',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);f.setTime('2026-10-21T06:00:00Z');// 9 am Karbala: once between meals.
 dom=domFor(f,'/scanner');const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('#scanResult')?.textContent.includes('Ready to scan'));
 assert.equal(d.querySelector('#manualSubmit').disabled,false);assert.equal(d.querySelector('.meal-strip'),null);assert.doesNotMatch(d.body.textContent,/closed/i);
 const form=d.querySelector('#manualScan'),input=d.querySelector('#manualCode');
 input.value=`MW1:${cards[0].token}`;submit(w,form);await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 assert.equal(d.querySelector('#scanResult strong').textContent,'ALLOW');
 await new Promise(r=>setTimeout(r,3100));d.querySelector('#scanResult').className='scan-result';input.value=`MW1:${cards[0].token}`;submit(w,form);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 await new Promise(r=>setTimeout(r,1400));input.value='MW1:unknown';submit(w,form);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('red'));assert.match(d.querySelector('#scanResult').textContent,/not recognised/);
 assert.equal(d.querySelector('[class*=yellow]'),null);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE reason='admitted'").get().n,2);
 }finally{dom?.window.close();f.close();}
});

test('scanner camera checks cards at any hour and toggles on and off',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);f.setTime('2026-10-21T20:00:00Z');// 11 pm Karbala.
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
 await waitFor(()=>printed.length===1&&d.querySelector('.safari-check'));
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
 // A per-meal admission recorded before meal times were removed is still archived.
 f.db.prepare("INSERT INTO admissions VALUES(?,'2026-10-21','breakfast',?,'2026-10-21T04:00:00Z')").run(cards[0].person_id,cards[0].id);await scan(f,'=HYPERLINK("bad")');f.setTime('2026-10-22T04:00:00Z');await scan(f,cards[1].token);
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
 assert.deepEqual([...archive.files.keys()].sort(),['cards.csv','daily-meal-summary.csv','meals-served.csv','print-log.csv','read-me.txt','scan-log.csv','tours.csv']);
 const scans=archive.files.get('scan-log.csv');assert.match(scans,/26\/3205,FH Kuwait,1,Admitted,admitted/);assert.match(scans,/Declined,unknown card/);
 assert.match(archive.files.get('daily-meal-summary.csv'),/2026-10-21,26\/3205,FH Kuwait,2,1,0,0/);
 assert.ok(![...archive.files.keys()].some(n=>n.endsWith('.pdf')));
 assert.match(d.querySelector('#archiveProgress').textContent,/2 scan records, 1 meals served/);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE date<'2026-10-22'").get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,0);
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
