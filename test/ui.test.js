// DOM integration tests exercise the real client and API, without camera/printer hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { fixture,tour,issue,config,manyStays } from './helpers.js';
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
  return {ok:result.status>=200&&result.status<300,status:result.status,headers:{get:name=>result.headers[name.toLowerCase()]??null},json:async()=>result.body,arrayBuffer:async()=>result.body};
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
 assert.equal(dom.window.document.querySelector('#startCamera').disabled,true);assert.equal(dom.window.document.querySelector('#manualSubmit').disabled,true);
 }finally{dom?.window.close();f.close();}
});

test('tours: count says current and upcoming by default and how many are shown when capped',async()=>{
 const f=await fixture();let dom;try{
 await request(f.app).post('/api/sync/tours').set('Authorization',`Bearer ${config.syncToken}`).send({spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',tours:manyStays(35,40)}).expect(200);
 f.setTime('2026-11-20T05:00:00Z');
 dom=domFor(f);const w=dom.window,d=w.document;
 await waitFor(()=>d.querySelector('#tourCount')?.textContent==='280 current and upcoming tours');
 d.querySelector('[name=q]').value='bulk office';submit(w,d.querySelector('#tourFilters'));
 await waitFor(()=>d.querySelectorAll('.tour-check').length===1000);
 assert.equal(d.querySelector('#tourCount').textContent,'Showing 1,000 of 1,400 tours — filter by arrival date or search to narrow the list');
 }finally{dom?.window.close();f.close();}
});
