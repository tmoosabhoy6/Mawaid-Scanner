import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeLabels } from '../src/labels.js';
import { JSDOM } from 'jsdom';
const config={ADMIN_PASSWORD:'worker-admin-password-12345',SCANNER_PASSWORD:'worker-scanner-password-6789',SYNC_TOKEN:'synthetic-worker-sync-token-1234567890'};
// Split a migration into statements; trigger bodies keep their inner semicolons because their lines are indented.
const statements=file=>readFileSync(`cloudflare/migrations/${file}`,'utf8').replace(/^--.*$/gm,'').trim().split(/;\s*\n(?=(?:CREATE|PRAGMA|DROP|INSERT|ALTER))/).map(s=>s.trim()).filter(Boolean);
const MIGRATIONS=['0001_initial.sql','0002_optional_tour_id_its_safari.sql'];
const compiled=await build({stdin:{contents:`import {respond} from './cloudflare/worker.js';export default {fetch(request,env){return respond(request,env,()=>new Date(request.headers.get('X-Test-Time')||'2026-10-21T04:00:00Z'));}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
async function fixture(overrides={},migrations=MIGRATIONS){
 const credentials={...config,...overrides};
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-20',d1Databases:['DB'],bindings:credentials}));
 let db;try{db=await mf.getD1Database('DB');}catch(e){await mf.dispose();throw e;}
 // Like `cf d1 migrations apply`, each migration runs as one atomic batch.
 for(const file of migrations)await db.batch(statements(file).map(sql=>db.prepare(sql)));
 const cookies={};let now='2026-10-21T04:00:00Z';
 const call=async(path,body,role='admin',extra={})=>{
  const headers={'X-Test-Time':now,...extra.headers};if(cookies[role])headers.Cookie=cookies[role];
  if(body!==undefined)headers['Content-Type']='application/json';
  const res=await mf.dispatchFetch('https://mawayid.test/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const cookie=res.headers.get('Set-Cookie');if(cookie)cookies[role]=cookie.split(';')[0];
  const data=res.headers.get('Content-Type')?.includes('application/json')?await res.json():new Uint8Array(await res.arrayBuffer());
  return{status:res.status,data,res};
 };
 for(const role of ['admin','scanner'])assert.equal((await call('/login',{role,password:role==='admin'?credentials.ADMIN_PASSWORD:credentials.SCANNER_PASSWORD},role)).status,200);
 const tour=async(pax=2,extra={})=>{const r=await call('/tours',{tour_id:'26/1',office:'Test office',arrival:'2026-10-21',departure:'2026-10-24',pax,...extra});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
 const issue=async(id,key=randomUUID())=>{const r=await call('/labels',{tourIds:[id],requestKey:key});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
 const scan=(token,key=randomUUID())=>call('/scan',{code:'MW1:'+token,requestKey:key},'scanner');
 return{mf,db,call,tour,issue,scan,cookies,setTime(value){now=value;},close:()=>mf.dispose()};
}

test('Cloudflare: configured short passwords work only for their assigned role',async()=>{
 const f=await fixture({SCANNER_PASSWORD:'S1',ADMIN_PASSWORD:'A1234'});try{
 assert.equal((await f.call('/session')).data.role,'admin');
 assert.equal((await f.call('/session',undefined,'scanner')).data.role,'scanner');
 assert.equal((await f.call('/login',{role:'admin',password:'S1'},'none')).status,401);
 assert.equal((await f.call('/login',{role:'scanner',password:'A1234'},'none')).status,401);
 assert.equal((await f.call('/login',{role:'admin',password:''},'none')).status,401);
 }finally{await f.close();}
});

test('Cloudflare: four phones scanning one valid card all see green; a replayed request stays red',async()=>{
 const f=await fixture();try{
 const t=await f.tour(4),b=await f.issue(t.id);
 const scans=await Promise.all(Array.from({length:4},()=>f.scan(b.cards[0].token)));
 assert.equal(scans.filter(r=>r.data.status==='green').length,4);assert.ok(scans.every(r=>r.data.meal===null));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admissions').first()).n,0);
 const replayKey=randomUUID();const accepted=await f.scan(b.cards[1].token,replayKey);assert.equal(accepted.data.status,'green');
 const retry=await f.scan(b.cards[1].token,replayKey);assert.equal(retry.data.status,'red');assert.equal(retry.data.replayed,true);
 f.setTime('2026-10-21T09:30:00Z');assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 f.setTime('2026-10-22T04:00:00Z');assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 }finally{await f.close();}
});

test('Cloudflare: replacement revokes old codes; retries reuse tokens',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),key=randomUUID(),b=await f.issue(t.id,key);
 const retry=await f.call('/labels',{tourIds:[t.id],requestKey:key});assert.equal(retry.data.cards[0].token,b.cards[0].token);
 await f.scan(b.cards[0].token);
 const replace=await f.call('/labels',{personIds:b.cards.map(c=>c.person_id),expectedCardIds:Object.fromEntries(b.cards.map(c=>[c.person_id,c.id])),requestKey:randomUUID()});assert.equal(replace.status,201);
 for(const c of b.cards)assert.equal((await f.scan(c.token)).data.reason,'replaced_card');
 assert.equal((await f.scan(replace.data.cards.find(c=>c.person_id===b.cards[0].person_id).token)).data.status,'green');
 assert.equal((await f.scan(replace.data.cards.find(c=>c.person_id===b.cards[1].person_id).token)).data.status,'green');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM people').first()).n,2);
 }finally{await f.close();}
});

test('Cloudflare: competing print operators roll back an overlapping allocation',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1);const jobs=await Promise.all([1,2].map(()=>f.call('/labels',{tourIds:[t.id],requestKey:randomUUID()})));
 assert.equal(jobs.filter(r=>r.status===201).length,1);assert.ok(jobs.some(r=>r.status===409||r.status===400));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM cards').first()).n,1);
 const person=await f.db.prepare('SELECT p.id,c.id AS card_id FROM people p JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL').first();
 const replacements=await Promise.all([1,2].map(()=>f.call('/labels',{personIds:[person.id],expectedCardIds:{[person.id]:person.card_id},requestKey:randomUUID()})));
 assert.equal(replacements.filter(r=>r.status===201).length,1);assert.ok(replacements.some(r=>r.status===409));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE revoked_at IS NULL').first()).n,1);
 }finally{await f.close();}
});

test('Cloudflare: unfinished PDFs recover after restart; immutable PDFs are saved before printing',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1),b=await f.issue(t.id);
 const stored=await f.db.prepare('SELECT envelope FROM batches WHERE id=?').bind(b.id).first();assert.equal(stored.envelope.includes(b.cards[0].token),false);
 const recovered=await f.call(`/batches/${b.id}/manifest`);assert.equal(recovered.data.cards[0].token,b.cards[0].token);
 const pdf=await makeLabels(recovered.data.cards,recovered.data.printer);
 const upload=()=>f.mf.dispatchFetch(`https://mawayid.test/api/batches/${b.id}/pdf`,{method:'POST',headers:{Cookie:f.cookies.admin,'Content-Type':'application/pdf'},body:pdf});
 assert.equal((await upload()).status,200);assert.equal((await upload()).status,200);
 const saved=await f.call(`/batches/${b.id}/pdf`);assert.equal(saved.status,200);assert.deepEqual(saved.data,new Uint8Array(pdf));
 assert.equal((await f.call(`/batches/${b.id}/manifest`)).data.requiresPdfUpload,false);
 assert.equal((await f.db.prepare('SELECT envelope FROM batches WHERE id=?').bind(b.id).first()).envelope,null);
 assert.equal((await f.call(`/batches/${b.id}/pdf`,undefined,'scanner')).status,403);
 }finally{await f.close();}
});

test('Cloudflare: unchanged sync snapshots avoid tour writes; PAX reductions and removed tours deny access',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const t={tour_id:'26/1',office:'Source',arrival:'2026-10-21',departure:'2026-10-24',pax:2};
 const sync=tours=>f.call('/sync/tours',{...source,tours},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 assert.equal((await sync([t])).data.changedTours,1);assert.equal((await sync([t])).data.changedTours,0);
 const tour=(await f.call('/tours')).data[0],b=await f.issue(tour.id);
 assert.equal((await sync([{...t,pax:1}])).data.changedTours,1);assert.equal((await f.scan(b.cards[1].token)).data.reason,'over_capacity');
 await sync([]);assert.equal((await f.scan(b.cards[0].token)).data.reason,'inactive_tour');
 }finally{await f.close();}
});

test('Cloudflare: stay dates, roles and CSRF block admission; any hour of a stay date is green',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1),b=await f.issue(t.id);
 for(const [time,reason]of [['2026-10-20T04:00:00Z','before_arrival'],['2026-10-21T06:00:00Z','admitted'],['2026-10-24T20:59:00Z','admitted'],['2026-10-25T04:00:00Z','after_departure']]){f.setTime(time);assert.equal((await f.scan(b.cards[0].token)).data.reason,reason);}
 assert.equal((await f.call('/tours',undefined,'scanner')).status,403);
 assert.equal((await f.call('/scan',{code:'MW1:x',requestKey:randomUUID()},'scanner',{headers:{Origin:'https://other.test'}})).status,403);
 assert.equal((await f.scan('unknown')).data.reason,'unknown_card');
 }finally{await f.close();}
});

test('Cloudflare: archive pages records, clears in bounded chunks and respects the daily write allowance',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),b=await f.issue(t.id);
 const pdf=await makeLabels(b.cards,b.printer);
 assert.equal((await f.mf.dispatchFetch(`https://mawayid.test/api/batches/${b.id}/pdf`,{method:'POST',headers:{Cookie:f.cookies.admin,'Content-Type':'application/pdf'},body:pdf})).status,200);
 for(const c of b.cards)assert.equal((await f.scan(c.token)).data.status,'green');
 // Per-meal admissions are no longer written; one recorded before the change is still archived and cleared.
 await f.db.prepare("INSERT INTO admissions VALUES(?,'2026-10-21','lunch',?,'2026-10-21T10:00:00Z')").bind(b.cards[0].person_id,b.cards[0].id).run();
 f.setTime('2026-10-22T04:00:00Z');assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 const status=await f.call('/archive?before=2026-10-22');assert.equal(status.status,200);
 assert.deepEqual(status.data.counts,{scans:2,meals:1,pdfs:0});assert.equal(status.data.cleanup.limit,40000);assert.equal(status.data.cleanup.used,0);
 assert.equal((await f.call('/archive?before=2026-10-23')).status,400);assert.equal((await f.call('/archive/clear',{before:''})).status,400);assert.equal((await f.call('/archive/clear',{})).status,400);assert.equal((await f.call('/archive',undefined,'scanner')).status,403);
 const page=await f.call('/archive/scans?before=2026-10-22&limit=1');assert.equal(page.data.rows.length,1);assert.ok(page.data.next);
 assert.equal((await f.call(`/archive/scans?before=2026-10-22&after=${page.data.next}`)).data.rows.length,1);
 assert.equal((await f.call('/archive/meals?before=2026-10-22')).data.rows.length,1);
 assert.equal((await f.call('/archive/prints?before=2026-10-22')).data.rows[0].labels,2);
 const cleared=await f.call('/archive/clear',{before:'2026-10-22'});assert.equal(cleared.status,200,JSON.stringify(cleared.data));
 assert.deepEqual(cleared.data.deleted,{scans:2,meals:1,pdfs:0});assert.equal(cleared.data.done,true);assert.ok(cleared.data.cleanup.used>=3);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').first()).n,1);
 f.setTime('2026-10-25T04:00:00Z');
 assert.equal((await f.call('/archive/clear',{before:'2026-10-25'})).data.deleted.pdfs,1);
 assert.equal((await f.call(`/batches/${b.id}/pdf`)).status,410);
 assert.equal((await f.call('/batches')).data[0].printer_status,'pdf_cleared');assert.equal((await f.call('/tours')).data[0].batch_status,'pdf_cleared');
 await f.db.prepare("INSERT INTO settings VALUES('cleanupUsage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({day:'2026-10-25',rowsWritten:35000})).run();
 const refused=await f.call('/archive/clear',{before:'2026-10-25'});assert.equal(refused.status,429);assert.match(refused.data.error,/allowance/);
 f.setTime('2026-10-26T04:00:00Z');assert.equal((await f.call('/archive/clear',{before:'2026-10-26'})).status,200);
 }finally{await f.close();}
});

test('Cloudflare capacity: 2,000 people, 6,000 green scans, four concurrent phones',async(t)=>{
 const f=await fixture();try{
 const tour=await f.tour(2000),cards=[];
 for(let n=0;n<20;n++){const batch=await f.issue(tour.id);assert.equal(batch.cards.length,100);cards.push(...batch.cards);assert.equal(batch.remaining,2000-cards.length);}
 assert.equal(new Set(cards.map(c=>c.token)).size,2000);
 const started=performance.now();
 for(const time of ['2026-10-21T04:00:00Z','2026-10-21T09:30:00Z','2026-10-21T16:00:00Z']){
 f.setTime(time);
 let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<cards.length){const c=cards[next++];assert.equal((await f.scan(c.token)).data.status,'green');}}));
 }
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE reason='admitted'").first()).n,6000);
 const summary=(await f.call('/summary?date=2026-10-21')).data[0];assert.equal(summary.people,2000);assert.equal(summary.scans,6000);
 t.diagnostic(`6,000 scans completed in ${((performance.now()-started)/1000).toFixed(1)} seconds in the local Cloudflare runtime; this excludes real network latency.`);
 }finally{await f.close();}
});

test('Cloudflare UI: failed PDF upload recovers the same cards through Print log',async()=>{
 const f=await fixture();let dom;
 const waitFor=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out');};
 try{
 await f.tour(1);
 dom=new JSDOM(readFileSync('public/index.html','utf8'),{url:'https://mawayid.test',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document;let failUpload=true;
 w.fetch=async(path,options={})=>{
  if(options.headers?.['Content-Type']==='application/pdf'&&failUpload){failUpload=false;return Response.json({error:'Test interrupted upload'},{status:503});}
  return f.mf.dispatchFetch(new URL(path,w.location.href).href,{...options,headers:{...options.headers,Cookie:f.cookies.admin,'X-Test-Time':'2026-10-21T04:00:00Z'}});
 };
 w.generateMawaidPdf=(cards,settings)=>makeLabels(cards,settings);
 const append=d.head.appendChild.bind(d.head);
 d.head.appendChild=element=>{const result=append(element);if(element.src.endsWith('/vendor/pdf.js'))queueMicrotask(()=>element.onload());return result;};
 w.eval(readFileSync('public/app.js','utf8'));
 await waitFor(()=>d.querySelector('.tour-check'));
 d.querySelector('#allTours').checked=true;d.querySelector('#allTours').dispatchEvent(new w.Event('change'));d.querySelector('#printSelected').click();
 await waitFor(()=>d.querySelector('#notice').textContent==='Test interrupted upload');
 const batch=await f.db.prepare('SELECT id FROM batches').first();
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM people').first()).n,1);
 w.location.hash='prints';await waitFor(()=>d.querySelector('.retry-print')?.textContent==='Finish PDF');
 d.querySelector('.retry-print').click();
 await waitFor(()=>d.querySelector('.retry-print')?.textContent==='Print PDF');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM batches').first()).n,1);
 assert.equal((await f.call(`/batches/${batch.id}/pdf`)).status,200);
 }finally{dom?.window.close();await f.close();}
});

test('Cloudflare: optional tour ID and ITS; Safari cards are stored without QR cards',async()=>{
 const f=await fixture();try{
 const base={office:'Walk-in',arrival:'2026-10-21',departure:'2026-10-24',pax:1};
 const a=await f.call('/tours',{...base,its:'30412345'}),b=await f.call('/tours',{...base,tour_id:' '});
 assert.equal(a.status,201);assert.equal(b.status,201);assert.equal(a.data.tour_id,null);assert.notEqual(a.data.id,b.data.id);
 assert.deepEqual((await f.call('/tours?q=30412345')).data.map(t=>t.id),[a.data.id]);
 const issued=await f.issue(a.data.id);assert.equal(issued.cards[0].tour_id,null);assert.equal((await f.scan(issued.cards[0].token)).data.status,'green');
 assert.equal((await f.call('/tours',{...base,tour_id:'26/9'})).status,201);assert.equal((await f.call('/tours',{...base,tour_id:'26/9',pax:4})).data.existing,true);
 const safari=await f.call('/safaris',{office:'Izan Caravan',arrival:'2026-10-21',departure:'2026-10-24',pax:12});assert.equal(safari.status,201);
 assert.equal((await f.call('/safaris',{})).status,201);assert.equal((await f.call('/safaris',{pax:-1})).status,400);
 assert.deepEqual((await f.call('/safaris?q=izan')).data.map(s=>s.id),[safari.data.id]);assert.equal((await f.call('/safaris')).data.length,2);
 assert.equal((await f.call('/safaris',undefined,'scanner')).status,403);
 assert.equal((await f.call('/labels',{tourIds:[safari.data.id],requestKey:randomUUID()})).status,404);
 }finally{await f.close();}
});

test('Cloudflare: migration 0002 keeps every tour, person, card and admission of a live database',async()=>{
 const f=await fixture({},MIGRATIONS.slice(0,1));try{
 await f.db.batch([`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t1','26/1','A','2026-10-21','2026-10-24',2,'x'),('t2','26/2','B','2026-10-21','2026-10-24',1,'x')`,
  `INSERT INTO people VALUES('p1','t1',1),('p2','t1',2),('p3','t2',1)`,`INSERT INTO batches(id,created_at,kind,request_key) VALUES('b1','x','initial','k1'),('b2','y','replacement','k2')`,
  `INSERT INTO cards(id,person_id,batch_id,token_hash,created_at,revoked_at) VALUES('c1','p1','b1','h1','x','y'),('c2','p2','b1','h2','x',NULL),('c3','p3','b1','h3','x',NULL),('c4','p1','b2','h4','y',NULL)`,
  `INSERT INTO scan_logs(request_key,card_id,person_id,tour_id,person_no,date,meal,reason,scanned_at) VALUES('s1','c2','p2','t1',2,'2026-10-21','lunch','admitted','x')`].map(sql=>f.db.prepare(sql)));
 const snapshot=async()=>{const out={};for(const table of ['tours','people','cards','admissions','scan_logs'])out[table]=(await f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()).results.map(({its,...row})=>row);return out;};
 const before=await snapshot();assert.equal(before.admissions.length,1);
 await f.db.batch(statements(MIGRATIONS[1]).map(sql=>f.db.prepare(sql)));
 assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 for(const [sql,error] of [[`INSERT INTO people VALUES('p9','t1',5)`,/invalid_person_capacity/],[`INSERT INTO people VALUES('p8','missing',1)`,/invalid_person_capacity/],
  [`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES('c9','p2','b2','h9','z')`,/UNIQUE/],
  [`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t5','26/1','A','2026-10-22','2026-10-26',1,'x')`,/overlapping_tour/]])await assert.rejects(f.db.prepare(sql).run(),error);
 await f.db.prepare(`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t3',NULL,'C','2026-10-21','2026-10-24',1,'x'),('t4',NULL,'D','2026-10-21','2026-10-25',1,'x')`).run();
 }finally{await f.close();}
});

test('Cloudflare: scanning works before migration 0002 is applied, without per-meal limits',async()=>{
 const f=await fixture({},MIGRATIONS.slice(0,1));try{
 const token='T'.repeat(43),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64');
 await f.db.batch([`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t1','26/1','A','2026-10-21','2026-10-24',1,'x')`,`INSERT INTO people VALUES('p1','t1',1)`,
  `INSERT INTO batches(id,created_at,kind,request_key) VALUES('b1','x','initial','k1')`,`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES('c1','p1','b1','${digest}','x')`].map(sql=>f.db.prepare(sql)));
 for(let n=0;n<3;n++)assert.equal((await f.scan(token)).data.status,'green');
 assert.equal((await f.scan('unknown')).data.reason,'unknown_card');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').first()).n,4);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admissions').first()).n,0);
 }finally{await f.close();}
});
