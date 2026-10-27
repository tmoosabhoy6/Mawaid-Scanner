import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeLabels,makeSafariLabels } from '../src/labels.js';
import { JSDOM } from 'jsdom';
import { hash } from '../cloudflare/crypto.js';
const config={ADMIN_PASSWORD:'worker-admin-password-12345',SYNC_TOKEN:'synthetic-worker-sync-token-1234567890'};
// Split a migration into statements; trigger bodies keep their inner semicolons because their lines are indented.
const statements=file=>readFileSync(`cloudflare/migrations/${file}`,'utf8').replace(/^--.*$/gm,'').trim().split(/;\s*\n(?=(?:CREATE|PRAGMA|DROP|INSERT|ALTER))/).map(s=>s.trim()).filter(Boolean);
const MIGRATIONS=['0001_initial.sql','0002_optional_tour_id_its_safari.sql','0003_safari_print_log.sql','0004_query_cost_and_daily_counts.sql','0005_extensions_offline_scans.sql'];
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
 // Only the administrator signs in; calls made as 'scanner' carry no session.
 assert.equal((await call('/login',{password:credentials.ADMIN_PASSWORD})).status,200);
 const tour=async(pax=2,extra={})=>{const r=await call('/tours',{tour_id:'26/1',office:'Test office',arrival:'2026-10-21',departure:'2026-10-24',pax,...extra});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
 const issue=async(id,key=randomUUID())=>{const r=await call('/labels',{tourIds:[id],requestKey:key});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
 const scan=(token,key=randomUUID())=>call('/scan',{code:'MW1:'+token,requestKey:key},'scanner');
 return{mf,db,call,tour,issue,scan,cookies,setTime(value){now=value;},close:()=>mf.dispose()};
}

test('Cloudflare: only the administrator signs in; the scanner works without a session',async()=>{
 const f=await fixture({ADMIN_PASSWORD:'A1234',SCANNER_PASSWORD:'S1'});try{
 assert.equal((await f.call('/session')).data.role,'admin');
 assert.equal((await f.call('/session',undefined,'scanner')).status,401);
 assert.equal((await f.call('/login',{password:'S1'},'none')).status,401);
 assert.equal((await f.call('/login',{role:'scanner',password:'S1'},'none')).status,401);
 assert.equal((await f.call('/login',{password:''},'none')).status,401);
 // A session left from the old Scanner sign-in no longer opens anything that needs one.
 await f.db.prepare("INSERT INTO sessions VALUES(?,'scanner',?)").bind(await hash('old-scanner-token'),Date.now()+60000).run();
 assert.equal((await f.call('/session',undefined,'old',{headers:{Cookie:'mawayid_session=old-scanner-token'}})).status,401);
 assert.equal((await f.call('/service',undefined,'scanner')).status,200);
 assert.equal((await f.call('/scan',{code:'MW1:x',requestKey:randomUUID()},'scanner')).data.reason,'breakfast_unlisted');
 }finally{await f.close();}
});

test('Cloudflare: four phones scanning one card produce exactly one green; a replayed request stays red',async()=>{
 const f=await fixture();try{
 const t=await f.tour(4),b=await f.issue(t.id);f.setTime('2026-10-21T09:30:00Z');
 const scans=await Promise.all(Array.from({length:4},()=>f.scan(b.cards[0].token)));
 assert.equal(scans.filter(r=>r.data.status==='green').length,1);assert.ok(scans.every(r=>r.data.meal==='lunch'));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admissions').first()).n,1);
 const replayKey=randomUUID();const accepted=await f.scan(b.cards[1].token,replayKey);assert.equal(accepted.data.status,'green');
 const retry=await f.scan(b.cards[1].token,replayKey);assert.equal(retry.data.status,'red');assert.equal(retry.data.replayed,true);
 f.setTime('2026-10-21T16:30:00Z');assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 // Breakfast lets all four phones show green, and still counts the person once.
 f.setTime('2026-10-22T04:00:00Z');const breakfast=await Promise.all(Array.from({length:4},()=>f.scan(b.cards[0].token)));
 assert.ok(breakfast.every(r=>r.data.status==='green'));assert.equal(breakfast.filter(r=>r.data.reason==='admitted').length,1);
 assert.equal((await f.call('/summary?date=2026-10-22')).data.breakfast,1);
 }finally{await f.close();}
});

test('Cloudflare: replacement revokes old codes; retries reuse tokens',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),key=randomUUID(),b=await f.issue(t.id,key);
 const retry=await f.call('/labels',{tourIds:[t.id],requestKey:key});assert.equal(retry.data.cards[0].token,b.cards[0].token);
 f.setTime('2026-10-21T09:30:00Z');await f.scan(b.cards[0].token);
 const replace=await f.call('/labels',{personIds:b.cards.map(c=>c.person_id),expectedCardIds:Object.fromEntries(b.cards.map(c=>[c.person_id,c.id])),requestKey:randomUUID()});assert.equal(replace.status,201);
 for(const c of b.cards)assert.equal((await f.scan(c.token)).data.reason,'replaced_card');
 assert.equal((await f.scan(replace.data.cards.find(c=>c.person_id===b.cards[0].person_id).token)).data.reason,'already_scanned');
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
 assert.equal((await f.call(`/batches/${b.id}/pdf`,undefined,'scanner')).status,401);
 }finally{await f.close();}
});

test('Cloudflare: unchanged sync snapshots avoid tour writes; PAX reductions and removed tours deny access',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const t={tour_id:'26/1',office:'Source',arrival:'2026-10-21',departure:'2026-10-24',pax:2};
 const sync=tours=>f.call('/sync/tours',{...source,tours},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 assert.equal((await sync([t])).data.changedTours,1);assert.equal((await sync([t])).data.changedTours,0);
 const tour=(await f.call('/tours')).data[0],b=await f.issue(tour.id);f.setTime('2026-10-21T09:30:00Z');
 assert.equal((await sync([{...t,pax:1}])).data.changedTours,1);assert.equal((await f.scan(b.cards[1].token)).data.reason,'over_capacity');
 await sync([]);assert.equal((await f.scan(b.cards[0].token)).data.reason,'inactive_tour');
 }finally{await f.close();}
});

test('Cloudflare: a corrected arrival date moves the stay with its cards, and one overlap never blocks the rest',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const sync=(tours,tab='Tours')=>f.call('/sync/tours',{...source,tab,tours},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 const moved={tour_id:'26/2728',office:'FH France',arrival:'2026-10-21',departure:'2026-10-24',pax:2};
 assert.equal((await sync([moved])).status,200);
 const listed=async()=>(await f.call('/tours')).data;const stay=(await listed())[0],b=await f.issue(stay.id);
 // Typed by hand without the 26/ prefix before the Sheet listed it.
 const manual=await f.tour(3,{tour_id:'2846',arrival:'2026-10-22',departure:'2026-10-23'}),m=await f.issue(manual.id);
 // A refused sync is shown in Settings until the next one succeeds.
 assert.equal((await sync([moved],'Other')).status,409);
 assert.match((await f.call('/settings')).data.syncError.message,/does not match/);
 f.setTime('2026-10-22T09:30:00Z');
 const result=await sync([{...moved,arrival:'2026-10-22'},{tour_id:'26/2846',office:'FH Kuwait',arrival:'2026-10-22',departure:'2026-10-24',pax:3},
  {tour_id:'26/3373',office:'Office',arrival:'2026-10-27',departure:'2026-10-29',pax:1}]);
 assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.skipped,0);
 const tours=await listed();
 assert.deepEqual(tours.map(t=>[t.tour_id,t.arrival,t.departure,t.issued,t.source]).sort(),[['26/2728','2026-10-22','2026-10-24',2,'sheets'],['26/2846','2026-10-22','2026-10-24',3,'sheets'],['26/3373','2026-10-27','2026-10-29',0,'sheets']]);
 assert.equal(tours.find(t=>t.tour_id==='26/2728').id,stay.id);assert.equal(tours.find(t=>t.tour_id==='26/2846').id,manual.id);
 assert.equal((await f.scan(b.cards[0].token)).data.status,'green');assert.equal((await f.scan(m.cards[2].token)).data.status,'green');
 const settings=(await f.call('/settings')).data;assert.equal(settings.syncError,null);assert.equal(settings.sync.imported,3);
 // An inactive stay that genuinely overlaps is left out with a warning; the other new stay still arrives.
 await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active) VALUES('old','26/3400','A','2026-10-20','2026-10-23',1,'sheets','old-key','x',0)").run();
 await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active) VALUES('older','26/3400','A','2026-10-24','2026-10-26',1,'sheets','older-key','x',0)").run();
 const kept=[{...moved,arrival:'2026-10-22'},{tour_id:'26/2846',office:'FH Kuwait',arrival:'2026-10-22',departure:'2026-10-24',pax:3},{tour_id:'26/3373',office:'Office',arrival:'2026-10-27',departure:'2026-10-29',pax:1}];
 const partial=await sync([...kept,{tour_id:'26/3400',office:'A',arrival:'2026-10-21',departure:'2026-10-25',pax:1},{tour_id:'26/3401',office:'B',arrival:'2026-10-28',departure:'2026-10-30',pax:2}]);
 assert.equal(partial.status,200);assert.equal(partial.data.skipped,1);
 assert.ok((await listed()).some(t=>t.tour_id==='26/3401'));assert.match((await f.call('/settings')).data.sync.warnings[0],/26\/3400 \(2026-10-21\): overlaps/);
 // The same Sheet is planned again next time, in case the stay it overlapped has been corrected.
 await f.db.prepare("DELETE FROM tours WHERE id='older'").run();
 const retried=await sync([...kept,{tour_id:'26/3400',office:'A',arrival:'2026-10-21',departure:'2026-10-25',pax:1},{tour_id:'26/3401',office:'B',arrival:'2026-10-28',departure:'2026-10-30',pax:2}]);
 assert.equal(retried.data.skipped,0);assert.deepEqual((await listed()).filter(t=>t.tour_id==='26/3400').map(t=>[t.id,t.arrival]),[['old','2026-10-21']]);
 }finally{await f.close();}
});

test('Cloudflare: a tour the Sheet still lists but leaves out keeps its printed cards working',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const sync=(tours,warnings=[])=>f.call('/sync/tours',{...source,tours,warnings},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 const a={tour_id:'26/2189',office:'FH Mumbai',arrival:'2026-10-21',departure:'2026-10-25',pax:2},b={tour_id:'26/3025',office:'FH Mumbai',arrival:'2026-10-21',departure:'2026-10-25',pax:1};
 assert.equal((await sync([a,b])).status,200);
 const stays=async()=>Object.fromEntries((await f.db.prepare('SELECT tour_id,active FROM tours').all()).results.map(r=>[r.tour_id,r.active]));
 const ids=(await f.call('/tours')).data,cardA=(await f.issue(ids.find(t=>t.tour_id==='26/2189').id)).cards[0],cardB=(await f.issue(ids.find(t=>t.tour_id==='26/3025').id)).cards[0];
 f.setTime('2026-10-21T09:30:00Z');
 // The office merges 26/3025 into 26/2189 on the arrival side only: the Sheet leaves both out, with warnings.
 const half=await sync([],['26/2189: arrival and Wada PAX differ; excluded.','26/3025 (2026-10-24): no arrival found; excluded.']);
 assert.equal(half.status,200);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':1});
 assert.equal((await f.scan(cardA.token)).data.status,'green');assert.equal((await f.scan(cardB.token)).data.status,'green');
 assert.match((await f.call('/settings')).data.sync.warnings[0],/Kept active .*26\/2189, 26\/3025/);
 // A tour gone from the Sheet altogether is still switched off.
 await sync([],['26/2189: arrival and Wada PAX differ; excluded.']);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':0});
 // Switched off by an earlier sync, then listed with a warning again: it comes back on.
 await sync([],['26/2189: arrival and Wada PAX differ; excluded.','26/3025 (2026-10-24): no arrival found; excluded.']);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':1});
 // Once the Sheet is fixed, the tour syncs normally with its new details.
 await sync([{...a,pax:3}]);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':0});
 assert.equal((await f.call('/tours')).data.find(t=>t.tour_id==='26/2189').pax,3);
 }finally{await f.close();}
});

test('Cloudflare: stay dates, roles and CSRF block admission; every hour belongs to a meal',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1),b=await f.issue(t.id);
 for(const [time,reason]of [['2026-10-20T09:30:00Z','before_arrival'],['2026-10-21T09:00:00Z','admitted'],['2026-10-21T15:00:00Z','already_scanned'],['2026-10-21T16:00:00Z','admitted'],['2026-10-24T20:59:00Z','admitted'],['2026-10-25T09:00:00Z','after_departure']]){f.setTime(time);assert.equal((await f.scan(b.cards[0].token)).data.reason,reason);}
 assert.equal((await f.call('/tours',undefined,'scanner')).status,401);
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
 f.setTime('2026-10-22T04:00:00Z');assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 const status=await f.call('/archive?before=2026-10-22');assert.equal(status.status,200);
 assert.deepEqual(status.data.counts,{scans:2,meals:2,pdfs:0});assert.equal(status.data.cleanup.limit,40000);assert.equal(status.data.cleanup.used,0);
 assert.equal((await f.call('/archive?before=2026-10-23')).status,400);assert.equal((await f.call('/archive/clear',{before:''})).status,400);assert.equal((await f.call('/archive/clear',{})).status,400);assert.equal((await f.call('/archive',undefined,'scanner')).status,401);
 const page=await f.call('/archive/scans?before=2026-10-22&limit=1');assert.equal(page.data.rows.length,1);assert.ok(page.data.next);
 assert.equal((await f.call(`/archive/scans?before=2026-10-22&after=${page.data.next}`)).data.rows.length,1);
 assert.equal((await f.call('/archive/meals?before=2026-10-22')).data.rows.length,2);
 assert.equal((await f.call('/archive/prints?before=2026-10-22')).data.rows[0].labels,2);
 const cleared=await f.call('/archive/clear',{before:'2026-10-22'});assert.equal(cleared.status,200,JSON.stringify(cleared.data));
 assert.deepEqual(cleared.data.deleted,{scans:2,meals:2,pdfs:0});assert.equal(cleared.data.done,true);assert.ok(cleared.data.cleanup.used>=3);
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
 for(const time of ['2026-10-21T04:00:00Z','2026-10-21T09:30:00Z','2026-10-21T16:30:00Z']){
 f.setTime(time);
 let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<cards.length){const c=cards[next++];assert.equal((await f.scan(c.token)).data.status,'green');}}));
 }
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM scan_logs WHERE reason='admitted'").first()).n,6000);
 const summary=(await f.call('/summary?date=2026-10-21')).data;assert.equal(summary.breakfast,2000);assert.equal(summary.lunch,2000);assert.equal(summary.dinner,2000);assert.equal(summary.scans,6000);
 t.diagnostic(`6,000 scans completed in ${((performance.now()-started)/1000).toFixed(1)} seconds in the local Cloudflare runtime; this excludes real network latency.`);
 }finally{await f.close();}
});

test('Cloudflare UI: failed PDF upload recovers the same cards through Print log',async()=>{
 const f=await fixture();let dom;
 const waitFor=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out');};
 try{
 await f.tour(1);
 dom=new JSDOM(readFileSync('public/index.html','utf8'),{url:'https://mawayid.test',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document;w.Date=class extends Date{constructor(...args){super(...(args.length?args:['2026-10-21T04:00:00Z']));}};let failUpload=true;
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
 // The Sheet's 26/ prefix left off, with other but overlapping dates, still finds the listed tour; a later stay is new.
 const listed=(await f.call('/tours',{...base,tour_id:'26/9'})).data,bare=(await f.call('/tours',{...base,tour_id:'9',arrival:'2026-10-23',departure:'2026-10-23'})).data;
 assert.equal(bare.existing,true);assert.equal(bare.id,listed.id);assert.equal(bare.issued,0);
 assert.equal((await f.call('/tours',{...base,tour_id:'9',arrival:'2026-10-25',departure:'2026-10-26'})).status,201);
 const safari=await f.call('/safaris',{office:'Izan Caravan',arrival:'2026-10-21',departure:'2026-10-24',pax:12});assert.equal(safari.status,201);
 assert.equal((await f.call('/safaris',{})).status,201);assert.equal((await f.call('/safaris',{pax:-1})).status,400);
 assert.deepEqual((await f.call('/safaris?q=izan')).data.map(s=>s.id),[safari.data.id]);assert.equal((await f.call('/safaris')).data.length,2);
 assert.equal((await f.call('/safaris',undefined,'scanner')).status,401);
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

test('Cloudflare: cards from the original schema still scan once per meal after every migration',async()=>{
 const f=await fixture({},MIGRATIONS.slice(0,1));try{
 const token='T'.repeat(43),digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('base64');
 await f.db.batch([`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t1','26/1','A','2026-10-21','2026-10-24',1,'x')`,`INSERT INTO people VALUES('p1','t1',1)`,
  `INSERT INTO batches(id,created_at,kind,request_key) VALUES('b1','x','initial','k1')`,`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES('c1','p1','b1','${digest}','x')`].map(sql=>f.db.prepare(sql)));
 for(const file of MIGRATIONS.slice(1))await f.db.batch(statements(file).map(sql=>f.db.prepare(sql)));
 f.setTime('2026-10-21T09:30:00Z');assert.equal((await f.scan(token)).data.status,'green');for(let n=0;n<2;n++)assert.equal((await f.scan(token)).data.reason,'already_scanned');
 assert.equal((await f.scan('unknown')).data.reason,'unknown_card');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').first()).n,4);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM admissions').first()).n,1);
 }finally{await f.close();}
});

test('Cloudflare: Safari sticker PDFs are saved in Print log and can be viewed and reprinted',async()=>{
 const f=await fixture();try{
 const a=(await f.call('/safaris',{office:'A',arrival:'2026-10-21',departure:'2026-10-24',pax:3})).data,b=(await f.call('/safaris',{})).data;
 const pdf=await makeSafariLabels([a,b],{widthMm:76.2,heightMm:50.8}),key=randomUUID();
 const save=(query,body=pdf)=>f.mf.dispatchFetch(`https://mawayid.test/api/safaris/print?${query}`,{method:'POST',headers:{Cookie:f.cookies.admin,'Content-Type':'application/pdf','X-Test-Time':'2026-10-21T04:00:00Z'},body}).then(async r=>({status:r.status,data:await r.json()}));
 const saved=await save(`requestKey=${key}&ids=${a.id},${b.id}`);assert.equal(saved.status,201,JSON.stringify(saved.data));
 assert.equal((await save(`requestKey=${key}&ids=${a.id},${b.id}`)).data.id,saved.data.id);
 assert.equal((await save(`requestKey=${randomUUID()}&ids=missing`)).status,404);assert.equal((await save(`requestKey=${randomUUID()}&ids=${a.id}`,'not a pdf')).status,400);
 const log=(await f.call('/batches')).data;assert.equal(log.length,1);assert.equal(log[0].kind,'safari');assert.equal(log[0].count,2);assert.equal(log[0].active_count,2);assert.equal(log[0].pdf_ready,1);
 const view=await f.call(`/batches/${saved.data.id}/pdf`);assert.equal(view.status,200);assert.deepEqual(view.data,new Uint8Array(pdf));
 const listed=(await f.call('/safaris')).data.find(s=>s.id===a.id);assert.equal(listed.batch_id,saved.data.id);assert.equal(listed.batch_status,'generated');
 assert.equal((await f.call(`/batches/${saved.data.id}/status`,{status:'printer_error'})).status,200);
 assert.equal((await f.call('/archive/prints?before=2026-10-21')).data.rows[0].labels,2);
 // Cleared only once every card in the job has ended: card A departs 24 October; the undated card counts from its print date.
 f.setTime('2026-10-25T04:00:00Z');assert.equal((await f.call('/archive/clear',{before:'2026-10-24'})).data.deleted.pdfs,0);
 assert.equal((await f.call('/archive/clear',{before:'2026-10-25'})).data.deleted.pdfs,1);assert.equal((await f.call(`/batches/${saved.data.id}/pdf`)).status,410);
 }finally{await f.close();}
});

test('Cloudflare: tours list keeps finished stays; Show and Sort by apply before the 1,000-row cap',async()=>{
 const f=await fixture();try{
 const done=await f.tour(1,{tour_id:'26/9',arrival:'2026-10-21',departure:'2026-10-22'});
 await f.tour(2,{tour_id:'26/10',arrival:'2026-10-25',departure:'2026-10-27'});await f.tour(1,{tour_id:'26/100',arrival:'2026-11-02',departure:'2026-11-04'});
 await f.issue(done.id);
 const tours=async query=>(await f.call(`/tours?${new URLSearchParams(query)}`)).data.map(t=>t.tour_id);
 assert.deepEqual(await tours({}),['26/100','26/10','26/9']);assert.deepEqual(await tours({sort:'oldest'}),['26/9','26/10','26/100']);
 assert.deepEqual(await tours({status:'printed'}),['26/9']);assert.deepEqual(await tours({status:'unprinted',q:'26/10'}),['26/100','26/10']);
 assert.deepEqual(await tours({sort:"x'; DROP TABLE tours; --",status:'other'}),['26/100','26/10','26/9']);
 const a=(await f.call('/safaris',{office:'A',arrival:'2026-10-21',departure:'2026-10-24'})).data;await f.call('/safaris',{office:'B',arrival:'2026-10-30',departure:'2026-11-01'});await f.call('/safaris',{office:'C'});
 const saved=await f.mf.dispatchFetch(`https://mawayid.test/api/safaris/print?requestKey=${randomUUID()}&ids=${a.id}`,{method:'POST',headers:{Cookie:f.cookies.admin,'Content-Type':'application/pdf','X-Test-Time':'2026-10-21T04:00:00Z'},body:await makeSafariLabels([a],{widthMm:76.2,heightMm:50.8})});
 assert.equal(saved.status,201);
 const safaris=async query=>(await f.call(`/safaris?${new URLSearchParams(query)}`)).data.map(s=>s.office);
 assert.deepEqual(await safaris({}),['B','A','C']);assert.deepEqual(await safaris({status:'printed'}),['A']);assert.deepEqual(await safaris({status:'unprinted',sort:'oldest'}),['B','C']);
 }finally{await f.close();}
});

test('Cloudflare: large history keeps scan and summary costs bounded; tour reads grow linearly',async(t)=>{
 const {tourList,scanLogQuery}=await import('../src/list-queries.js');
 const {SUMMARY_SQL}=await import('../src/summary.js');
 const {SCAN_SQL}=await import('../src/scan-query.js');
 const f=await fixture();try{
 const tours=Array.from({length:500},(_,i)=>({id:`large-t${i}`,tour_id:`large-${i}`}));
 await f.db.prepare(`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.tour_id'),'Load test','2026-10-21','2026-10-24',20,'x' FROM json_each(?)`).bind(JSON.stringify(tours)).run();
 await f.db.prepare("INSERT INTO batches(id,created_at,kind,request_key) VALUES('large-b','x','initial','large-b')").run();
 for(let chunk=0;chunk<20;chunk++){
  const people=Array.from({length:500},(_,n)=>{const i=chunk*500+n;return{id:`large-p${i}`,tour:`large-t${Math.floor(i/20)}`,n:i%20+1};});
  await f.db.prepare(`INSERT INTO people SELECT json_extract(value,'$.id'),json_extract(value,'$.tour'),json_extract(value,'$.n') FROM json_each(?)`).bind(JSON.stringify(people)).run();
  await f.db.prepare(`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'large-b',json_extract(value,'$.id'),'x' FROM json_each(?)`).bind(JSON.stringify(people)).run();
 }
 await f.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
 INSERT INTO scan_logs(request_key,date,reason,scanned_at) SELECT 'history-'||i,'2026-10-20','unknown_card','x' FROM n`).run();
 const scans=[];
 for(const [key,meal] of [['load-first','breakfast'],['load-lunch','lunch'],['load-duplicate','lunch'],['load-dinner','dinner']]) {
   const r=await f.db.prepare(SCAN_SQL).bind(key,'2026-10-21','2026-10-21T04:00:00Z','large-p0',meal,0,0).all();
   assert.equal(r.results[0].reason,key==='load-duplicate'?'already_scanned':'admitted');
   assert.ok(r.meta.rows_read<100,JSON.stringify(r.meta));assert.ok(r.meta.rows_written<=10,JSON.stringify(r.meta));scans.push(r.meta);
 }
 const query=tourList(),list=await f.db.prepare(query.sql).all();
 assert.equal(list.results.length,500);assert.ok(list.meta.rows_read<150000,JSON.stringify(list.meta));
 const summary=await f.db.prepare(SUMMARY_SQL).bind('2026-10-21').all();
 assert.deepEqual(summary.results[0],{date:'2026-10-21',breakfast:1,lunch:1,dinner:1,other:0,scans:3});assert.ok(summary.meta.rows_read<=2);
 const logs=scanLogQuery({date:'2026-10-21'}),recent=await f.db.prepare(logs.sql).bind(...logs.params).all();assert.equal(recent.results.length,4);assert.ok(recent.meta.rows_read<40);
 // A date without a counter still returns zeroes. Deleting old logs updates their stored totals.
 assert.equal((await f.call('/summary?date=2026-10-19')).data.scans,0);
 await f.db.prepare("DELETE FROM scan_logs WHERE date='2026-10-21'").run();assert.equal((await f.call('/summary?date=2026-10-21')).data.scans,0);
 // A gate phone downloads every current card once; each later poll reads only what changed since.
 const {offlineData}=await import('../src/offline.js');const reads=[];
 const q=async(sql,...args)=>{const r=await f.db.prepare(sql).bind(...args).all();reads.push(r.meta.rows_read);return r.results;};
 const full=await offlineData(q,new URL('https://x/'),{date:'2026-10-21'},'base64');
 assert.equal(full.cards.length,10000);assert.equal(full.tours.length,500);assert.equal(full.admissions.length,3);
 const fullReads=reads.splice(0).reduce((a,b)=>a+b,0);assert.ok(fullReads<60000,String(fullReads));
 const poll=await offlineData(q,new URL(`https://x/?cards=${full.cardCursor}&admissions=${full.admissionCursor}&date=2026-10-21`),{date:'2026-10-21'},'base64');
 assert.equal(poll.cards.length,0);assert.equal(poll.admissions.length,0);assert.equal(poll.tours,undefined);
 const pollReads=reads.splice(0).reduce((a,b)=>a+b,0);assert.ok(pollReads<20,String(pollReads));
 // Public status checks are safe even if the database binding would throw on any I/O.
 const {respond}=await import('../cloudflare/worker.js');
 const status=await respond(new Request('https://mawayid.test/api/service'),{...config,DB:{prepare(){throw Error('Unexpected D1 read');}}},()=>new Date('2026-10-21T04:00:00Z'));
 assert.equal(status.status,200);assert.equal((await status.json()).meal,'breakfast');
 t.diagnostic(JSON.stringify({dataset:{tours:500,cards:10000,old_scans:20000},tour_rows_read:list.meta.rows_read,offline_full_rows_read:fullReads,offline_poll_rows_read:pollReads,summary_rows_read:summary.meta.rows_read,scans:scans.map(m=>({read:m.rows_read,written:m.rows_written}))}));
 }finally{await f.close();}
});

test('Cloudflare: migration backfills legacy scans without altering logs or meal history',async()=>{
 const f=await fixture({},MIGRATIONS.slice(0,3));try{
 await f.db.prepare(`INSERT INTO scan_logs(request_key,date,meal,reason,scanned_at) VALUES('legacy1','2026-10-20',NULL,'admitted','x'),('legacy2','2026-10-20',NULL,'admitted','x'),('declined','2026-10-20',NULL,'unknown_card','x')`).run();
 const before=(await f.db.prepare('SELECT * FROM scan_logs').all()).results;
 for(const file of MIGRATIONS.slice(3))await f.db.batch(statements(file).map(sql=>f.db.prepare(sql)));
 // 0005 only adds the offline flag, which is 0 for every earlier scan.
 assert.deepEqual((await f.db.prepare('SELECT * FROM scan_logs').all()).results,before.map(r=>({...r,offline:0})));
 const counts=(await f.call('/summary?date=2026-10-20')).data;
 assert.deepEqual(counts,{date:'2026-10-20',breakfast:0,lunch:0,dinner:0,other:2,scans:2});
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await f.close();}
});

test('Cloudflare: extended stays, offline scans, the phone card list and the tour report',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),b=await f.issue(t.id),[one,two]=b.cards;
 // The phone's list holds base64 card hashes and no office names.
 const full=(await f.call('/scanner/data',undefined,'scanner')).data;
 assert.equal(full.hash,'base64');assert.deepEqual(full.cards.map(c=>c[0]).sort(),[await hash(one.token),await hash(two.token)].sort());assert.ok(!JSON.stringify(full).includes('Test office'));
 assert.equal((await f.call(`/tours/${t.id}/extensions`,{date:'2026-10-25',meals:'lunch'},'scanner')).status,401);
 assert.equal((await f.call(`/tours/${t.id}/extensions`,{date:'2026-10-24',meals:'lunch'})).status,400);
 const ext=await f.call(`/tours/${t.id}/extensions`,{date:'2026-10-25',meals:'lunch'});assert.equal(ext.status,201);
 f.setTime('2026-10-25T16:30:00Z');assert.equal((await f.scan(one.token)).data.reason,'extension_other_meal');
 f.setTime('2026-10-25T09:00:00Z');const green=await f.scan(one.token);assert.equal(green.data.status,'green');
 const dup=await f.scan(one.token);assert.equal(dup.data.reason,'already_scanned');assert.equal(dup.data.firstScannedAt,green.data.scanned_at);
 f.setTime('2026-10-26T09:00:00Z');assert.equal((await f.scan(one.token)).data.reason,'after_departure');
 // An offline phone's lunch scan from yesterday is counted for yesterday.
 const offline=await f.call('/scan',{code:'MW1:'+two.token,requestKey:randomUUID(),offlineAt:'2026-10-25T09:30:00Z',offlineStatus:'green'},'scanner');
 assert.deepEqual([offline.data.reason,offline.data.date,offline.data.meal,offline.data.offline],['admitted','2026-10-25','lunch',1]);
 const declined=await f.call('/scan',{code:'MW1:'+two.token,requestKey:randomUUID(),offlineAt:'2026-10-21T09:30:00Z',offlineStatus:'green'},'scanner');assert.equal(declined.status,400);
 const report=(await f.call('/summary/tours?date=2026-10-25')).data;
 assert.deepEqual(report.map(r=>[r.tour_id,r.extension,r.breakfast,r.lunch,r.dinner]),[['26/1','lunch',0,2,0]]);
 assert.equal((await f.call('/summary?date=2026-10-25')).data.lunch,2);
 assert.equal((await f.call(`/extensions/${ext.data.id}/remove`,{})).status,200);
 assert.equal((await f.call(`/tours/${t.id}/extensions`)).data[0].removed_at!==null,true);
 assert.equal((await f.call('/archive/extensions?before=2026-10-26')).data.rows.length,1);
 }finally{await f.close();}
});
