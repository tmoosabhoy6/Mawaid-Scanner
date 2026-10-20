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
  if(options.body)req=req.send(JSON.parse(options.body));
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
 for(const [key,value]of Object.entries({tour_id:'26/1',office:'<script>globalThis.bad=true</script>',arrival:'2026-10-21',departure:'2026-10-22',pax:'3'}))d.querySelector(`[name=${key}]`).value=value;
 const form=d.querySelector('#addTour');submit(w,form,d.querySelector('[value=save]'));
 await waitFor(()=>d.querySelectorAll('.tour-check').length===1);
 assert.ok(d.querySelector('#tourTable').textContent.includes('<script>'));assert.equal(w.bad,undefined);assert.equal(d.querySelector('#tourTable script'),null);
 w.location.hash='settings';await waitFor(()=>d.querySelector('#sourceSettings'));
 d.querySelector('[name=dailyTimes]').value='06:00, 12:00';submit(w,d.querySelector('#sourceSettings'));
 await waitFor(()=>{const row=f.db.prepare("SELECT value FROM settings WHERE key='source'").get();return row&&JSON.parse(row.value).dailyTimes?.length===2;});
 d.querySelector('#requestSync').click();await waitFor(()=>f.db.prepare("SELECT value FROM settings WHERE key='syncRequestedAt'").get());
 await waitFor(()=>d.querySelector('#notice').textContent.includes('Sync requested'));
 }finally{dom?.window.close();f.close();}
});

test('scanner: unused QR green, duplicate red, no yellow state and closed service disables scanning',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);
 dom=domFor(f,'/scanner');const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('#manualSubmit')?.disabled===false);
 const form=d.querySelector('#manualScan'),input=d.querySelector('#manualCode');
 input.value=`MW1:${cards[0].token}`;submit(w,form);await waitFor(()=>d.querySelector('#scanResult').classList.contains('green'));
 assert.equal(d.querySelector('#scanResult strong').textContent,'ALLOW');
 await new Promise(r=>setTimeout(r,3100));input.value=`MW1:${cards[0].token}`;submit(w,form);
 await waitFor(()=>d.querySelector('#scanResult').classList.contains('red'));
 assert.match(d.querySelector('#scanResult').textContent,/already been used/);
 assert.equal(d.querySelector('[class*=yellow]'),null);
 dom.window.close();f.setTime('2026-10-21T06:00:00Z');dom=domFor(f,'/scanner');
 await waitFor(()=>dom.window.document.querySelector('#scanResult')?.textContent.includes('Meal service closed'));
 assert.equal(dom.window.document.querySelector('#manualSubmit').disabled,true);
 }finally{dom?.window.close();f.close();}
});

test('scanner camera opens outside meal times but checks cards only while a meal is open',async()=>{
 const f=await fixture();let dom;try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);f.setTime('2026-10-21T06:00:00Z');
 dom=new JSDOM(html,{url:'https://localhost:3000/scanner',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document;let decode,stopped=0;
 w.fetch=async(url,options={})=>{const path=new URL(url,w.location.href).pathname+new URL(url,w.location.href).search;let req=options.method==='POST'?f.scanner.post(path):f.scanner.get(path);if(options.body)req=req.send(JSON.parse(options.body));const r=await req;return{ok:r.status<300,status:r.status,json:async()=>r.body};};
 Object.defineProperty(w,'isSecureContext',{value:true});// jsdom does not implement secure contexts.
 w.MawaidCamera=class{async start(camera,config,onDecode){decode=onDecode;}async stop(){stopped++;}clear(){}};
 w.eval(js);
 await waitFor(()=>d.querySelector('#scanResult')?.textContent.includes('Meal service closed'));
 const button=d.querySelector('#startCamera');assert.equal(button.disabled,false);
 button.click();await waitFor(()=>button.textContent==='Stop camera');
 decode(`MW1:${cards[0].token}`);
 await waitFor(()=>/not checked/.test(d.querySelector('#scanResult').textContent));
 await new Promise(r=>setTimeout(r,100));assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,0);
 button.click();await waitFor(()=>button.textContent==='Start camera');assert.equal(stopped,1);
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
 await scan(f,cards[0].token);await scan(f,'=HYPERLINK("bad")');f.setTime('2026-10-22T04:00:00Z');await scan(f,cards[1].token);
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
