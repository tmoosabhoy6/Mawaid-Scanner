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
const statements=file=>readFileSync(`cloudflare/migrations/${file}`,'utf8').replace(/^--.*$/gm,'').trim().split(/;\s*\n(?=(?:CREATE|PRAGMA|DROP|INSERT|ALTER|UPDATE))/).map(s=>s.trim()).filter(Boolean);
const MIGRATIONS=['0001_initial.sql','0002_optional_tour_id_its_safari.sql','0003_safari_print_log.sql','0004_query_cost_and_daily_counts.sql','0005_extensions_offline_scans.sql','0006_scanner_gates.sql','0007_shared_tour_id.sql','0008_card_numbers.sql','0009_tour_number_entry.sql'];
const compiled=await build({stdin:{contents:`import {respond,refreshNkerp} from './cloudflare/worker.js';export default {fetch(request,env){return respond(request,env,()=>new Date(request.headers.get('X-Test-Time')||'2026-10-21T04:00:00Z'));},scheduled(controller,env,ctx){ctx.waitUntil(refreshNkerp(env,new Date(controller.scheduledTime)));}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
async function fixture(overrides={},migrations=MIGRATIONS,outboundService=undefined){
 const credentials={...config,...overrides};
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-20',d1Databases:['DB'],bindings:credentials,...(outboundService?{outboundService}:{})}));
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
 // Replacing cards is no longer offered; this recreates a card replaced earlier, as the live database still holds them.
 const replaceCard=async card=>{
  const batch=randomUUID(),id=randomUUID(),token=randomUUID();
  await db.batch([db.prepare("INSERT INTO batches(id,created_at,kind,request_key) VALUES(?,?,'replacement',?)").bind(batch,now,batch),
   db.prepare('UPDATE cards SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL').bind(now,card.person_id),
   db.prepare('INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES(?,?,?,?,?)').bind(id,card.person_id,batch,await hash(token),now)]);
  return{...card,id,token};
 };
 return{mf,db,call,tour,issue,scan,replaceCard,cookies,setTime(value){now=value;},close:()=>mf.dispose()};
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

test('Cloudflare: retries reuse tokens; replacing is refused; cards replaced earlier stay red',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),key=randomUUID(),b=await f.issue(t.id,key);
 const retry=await f.call('/labels',{tourIds:[t.id],requestKey:key});assert.equal(retry.data.cards[0].token,b.cards[0].token);
 f.setTime('2026-10-21T09:30:00Z');await f.scan(b.cards[0].token);
 const replace=await f.call('/labels',{personIds:b.cards.map(c=>c.person_id),expectedCardIds:Object.fromEntries(b.cards.map(c=>[c.person_id,c.id])),requestKey:randomUUID()});
 assert.equal(replace.status,400);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE revoked_at IS NOT NULL').first()).n,0);
 assert.equal((await f.call(`/tours/${t.id}/people`)).status,404);
 assert.match((await f.call('/labels',{tourIds:[t.id],requestKey:randomUUID()})).data.error,/add a tour for new cards/);
 const newer=await f.replaceCard(b.cards[0]);
 assert.equal((await f.scan(b.cards[0].token)).data.reason,'replaced_card');
 assert.equal((await f.scan(newer.token)).data.reason,'already_scanned');
 assert.equal((await f.scan(b.cards[1].token)).data.status,'green');
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM people').first()).n,2);
 }finally{await f.close();}
});

test('Cloudflare: competing print operators roll back an overlapping allocation',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1);const jobs=await Promise.all([1,2].map(()=>f.call('/labels',{tourIds:[t.id],requestKey:randomUUID()})));
 assert.equal(jobs.filter(r=>r.status===201).length,1);assert.ok(jobs.some(r=>r.status===409||r.status===400));
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM cards').first()).n,1);
 assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM people').first()).n,1);
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

test('Cloudflare: unchanged sync snapshots avoid tour writes; printed cards outlast a lower PAX or removal',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const t={tour_id:'26/1',office:'Source',arrival:'2026-10-21',departure:'2026-10-24',pax:2};
 const sync=tours=>f.call('/sync/tours',{...source,tours},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 assert.equal((await sync([t])).data.changedTours,1);assert.equal((await sync([t])).data.changedTours,0);
 const tour=(await f.call('/tours')).data[0],b=await f.issue(tour.id);f.setTime('2026-10-21T09:30:00Z');
 assert.equal((await sync([{...t,pax:1}])).data.changedTours,0);assert.equal((await f.scan(b.cards[1].token)).data.status,'green');
 assert.equal((await sync([{...t,pax:3}])).data.changedTours,1);assert.equal((await f.call('/tours')).data[0].pax,3);
 // A tour with printed cards outlasts its removal from the Sheet; one with none is switched off.
 await sync([{...t,pax:3},{...t,tour_id:'26/2'}]);await sync([]);assert.equal((await f.scan(b.cards[0].token)).data.status,'green');
 assert.deepEqual((await f.call('/tours')).data.map(x=>x.tour_id),['26/1']);
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
 // (Before Add tour required the full tour ID.)
 const manual={id:'manual'};await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('manual','2846','Test office','2026-10-22','2026-10-23',3,'x')").run();const m=await f.issue(manual.id);
 // A refused sync is shown in Settings until the next one succeeds.
 assert.equal((await sync([moved],'Other')).status,409);
 assert.match((await f.call('/settings')).data.syncError.message,/does not match/);
 f.setTime('2026-10-22T09:30:00Z');
 const result=await sync([{...moved,arrival:'2026-10-22'},{tour_id:'26/2846',office:'FH Kuwait',arrival:'2026-10-22',departure:'2026-10-24',pax:3},
  {tour_id:'26/3373',office:'Office',arrival:'2026-10-27',departure:'2026-10-29',pax:1}]);
 assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.skipped,0);
 const tours=await listed();
 assert.deepEqual(tours.map(t=>[t.tour_id,t.arrival,t.departure,t.issued,t.source]).sort(),[['26/2728','2026-10-21','2026-10-24',2,'sheets'],['26/2846','2026-10-22','2026-10-24',3,'sheets'],['26/3373','2026-10-27','2026-10-29',0,'sheets']]);
 assert.equal(tours.find(t=>t.tour_id==='26/2728').id,stay.id);assert.equal(tours.find(t=>t.tour_id==='26/2846').id,manual.id);
 assert.equal((await f.scan(b.cards[0].token)).data.status,'green');assert.equal((await f.scan(m.cards[2].token)).data.status,'green');
 const settings=(await f.call('/settings')).data;assert.equal(settings.syncError,null);assert.equal(settings.sync.imported,3);
 // An inactive stay that genuinely overlaps is left out with a warning; the other new stay still arrives.
 await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active) VALUES('old','26/3400','A','2026-10-20','2026-10-23',1,'sheets','old-key','x',0)").run();
 await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active) VALUES('older','26/3400','A','2026-10-24','2026-10-26',1,'sheets','older-key','x',0)").run();
 const kept=[{...moved,arrival:'2026-10-22'},{tour_id:'26/2846',office:'FH Kuwait',arrival:'2026-10-22',departure:'2026-10-24',pax:3},{tour_id:'26/3373',office:'Office',arrival:'2026-10-27',departure:'2026-10-29',pax:1}];
 const partial=await sync([...kept,{tour_id:'26/3400',office:'A',arrival:'2026-10-21',departure:'2026-10-25',pax:1},{tour_id:'26/3401',office:'B',arrival:'2026-10-28',departure:'2026-10-30',pax:2}]);
 assert.equal(partial.status,200);assert.equal(partial.data.skipped,1);
 assert.ok((await listed()).some(t=>t.tour_id==='26/3401'));assert.match((await f.call('/settings')).data.sync.warnings.join(' '),/26\/3400 \(2026-10-21\): overlaps/);
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
 // A tour gone from the Sheet altogether keeps its printed cards working too.
 await sync([],['26/2189: arrival and Wada PAX differ; excluded.']);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':1});
 f.setTime('2026-10-21T16:30:00Z');assert.equal((await f.scan(cardB.token)).data.status,'green');
 // Switched off before this rule (as on 27 October): the next sync switches it back on.
 await f.db.prepare("UPDATE tours SET active=0 WHERE tour_id='26/3025'").run();
 await sync([{...a,pax:3}]);assert.deepEqual(await stays(),{'26/2189':1,'26/3025':1});
 // Once the Sheet is fixed, the tour syncs normally with its new details, and the note stays after an unchanged sync.
 await sync([{...a,pax:3}]);assert.match((await f.call('/settings')).data.sync.warnings.join(' '),/26\/3025 \(2026-10-21\): no longer in the Sheet; its 1 printed cards still work/);
 assert.equal((await f.call('/tours')).data.find(t=>t.tour_id==='26/2189').pax,3);
 }finally{await f.close();}
});

test('Cloudflare: stay dates, roles and CSRF block admission; every hour belongs to a meal',async()=>{
 const f=await fixture();try{
 const t=await f.tour(1),b=await f.issue(t.id);
 for(const [time,reason]of [['2026-10-20T09:30:00Z','before_arrival'],['2026-10-21T10:00:00Z','admitted'],['2026-10-21T15:00:00Z','already_scanned'],['2026-10-21T16:00:00Z','admitted'],['2026-10-24T20:59:00Z','admitted'],['2026-10-25T10:00:00Z','after_departure']]){f.setTime(time);assert.equal((await f.scan(b.cards[0].token)).data.reason,reason);}
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

test('Cloudflare: add tour needs the full tour ID; an ID already in the app adds cards under it; Safari cards have no QR',async()=>{
 const f=await fixture();try{
 const base={office:'Walk-in',arrival:'2026-10-21',departure:'2026-10-24',pax:1};
 for(const tour_id of [undefined,' ','9','2026/9','26-9'])assert.equal((await f.call('/tours',{...base,tour_id})).status,400,String(tour_id));
 assert.match((await f.call('/tours',{...base,tour_id:'26/9',office:''})).data.error,/office name/);
 const listed=await f.call('/tours',{...base,tour_id:'26/9',its:'30412345'});assert.equal(listed.status,201);assert.equal(listed.data.shared,false);
 assert.deepEqual((await f.call('/tours?q=30412345')).data.map(t=>t.id),[listed.data.id]);
 // The same ID for overlapping dates, and for the same arrival, adds a stay under that ID; its office is filled in.
 const extra=await f.call('/tours',{tour_id:'26/9',pax:2,arrival:'2026-10-23',departure:'2026-10-26'}),same=await f.call('/tours',{...base,tour_id:' 26/9 '});
 assert.equal(extra.status,201);assert.equal(same.status,201);assert.deepEqual([extra.data.tour_id,extra.data.office,extra.data.shared],['26/9','Walk-in',true]);
 assert.deepEqual(await f.db.prepare('SELECT tour_id,shared_tour_id FROM tours WHERE id=?').bind(extra.data.id).first(),{tour_id:null,shared_tour_id:'26/9'});
 const issued=await f.issue(extra.data.id);assert.deepEqual(issued.cards.map(c=>c.tour_id),['26/9','26/9']);
 assert.deepEqual((await f.call('/tours?q=26/9')).data.map(t=>t.tour_id),['26/9','26/9','26/9']);
 f.setTime('2026-10-23T09:30:00Z');assert.equal((await f.scan(issued.cards[0].token)).data.status,'green');
 assert.deepEqual((await f.call('/logs?tour=26/9')).data.map(l=>l.display_tour),['26/9']);
 assert.deepEqual((await f.call('/summary/tours?date=2026-10-23')).data.map(t=>t.tour_id),['26/9','26/9','26/9']);
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
 const {tourList,scanLogQuery,gateCountQuery}=await import('../src/list-queries.js');
 const {SUMMARY_SQL}=await import('../src/summary.js');
 const {SCAN_SQL}=await import('../src/scan-query.js');
 const f=await fixture();try{
 const tours=Array.from({length:500},(_,i)=>({id:`large-t${i}`,tour_id:`large-${i}`}));
 await f.db.prepare(`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.tour_id'),'Load test','2026-10-21','2026-10-24',20,'x' FROM json_each(?)`).bind(JSON.stringify(tours)).run();
 await f.db.prepare("INSERT INTO batches(id,created_at,kind,request_key) VALUES('large-b','x','initial','large-b')").run();
 for(let chunk=0;chunk<20;chunk++){
  const people=Array.from({length:500},(_,n)=>{const i=chunk*500+n;return{id:`large-p${i}`,tour:`large-t${Math.floor(i/20)}`,n:i%20+1};});
  await f.db.prepare(`INSERT INTO people(id,tour_id,person_no) SELECT json_extract(value,'$.id'),json_extract(value,'$.tour'),json_extract(value,'$.n') FROM json_each(?)`).bind(JSON.stringify(people)).run();
  await f.db.prepare(`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'large-b',json_extract(value,'$.id'),'x' FROM json_each(?)`).bind(JSON.stringify(people)).run();
 }
 await f.db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
 INSERT INTO scan_logs(request_key,date,reason,scanned_at) SELECT 'history-'||i,'2026-10-20','unknown_card','x' FROM n`).run();
 const scans=[];
 for(const [key,meal] of [['load-first','breakfast'],['load-lunch','lunch'],['load-duplicate','lunch'],['load-dinner','dinner']]) {
   const r=await f.db.prepare(SCAN_SQL).bind(key,'2026-10-21','2026-10-21T04:00:00Z','large-p0',meal,0,0,'men',null,null,null).all();
   assert.equal(r.results[0].reason,key==='load-duplicate'?'already_scanned':'admitted');
   assert.ok(r.meta.rows_read<100,JSON.stringify(r.meta));assert.ok(r.meta.rows_written<=10,JSON.stringify(r.meta));scans.push(r.meta);
 }
 // A typed card number reads only the few people holding it, through people_sticker, among 10,000 cards.
 const {TYPED_SQL,typedParams}=await import('../src/sticker.js');
 await f.db.prepare("UPDATE people SET sticker_no=person_no,sticker_tour=substr(tour_id,8)").run();
 const typed=await f.db.prepare(TYPED_SQL).bind(...typedParams('07123')).all();
 assert.deepEqual(typed.results.map(r=>r.person_id),['large-p2466']);assert.ok(typed.meta.rows_read<20,JSON.stringify(typed.meta));
 const query=tourList(),list=await f.db.prepare(query.sql).all();
 assert.equal(list.results.length,500);assert.ok(list.meta.rows_read<150000,JSON.stringify(list.meta));
 const summary=await f.db.prepare(SUMMARY_SQL).bind('2026-10-21').all();
 assert.deepEqual(summary.results[0],{date:'2026-10-21',breakfast:1,lunch:1,dinner:1,other:0,scans:3});assert.ok(summary.meta.rows_read<=2);
 const logs=scanLogQuery({date:'2026-10-21'}),recent=await f.db.prepare(logs.sql).bind(...logs.params).all();assert.equal(recent.results.length,4);assert.ok(recent.meta.rows_read<40);
 // Men's and women's totals read only the chosen date, never the 20,000 older scans.
 const gates=gateCountQuery({date:'2026-10-21'}),byGate=await f.db.prepare(gates.sql).bind(...gates.params).all();
 assert.deepEqual(byGate.results.map(r=>[r.gate,r.admitted,r.declined]),[['men',3,1]]);assert.ok(byGate.meta.rows_read<40,JSON.stringify(byGate.meta));
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
 // A tour number typed for a card with no number reads only that tour's people, through people_sticker. When the guest
 // it was counted for scans their own card, the meal moves to another guest of the tour at a similar cost.
 const byTour=await f.db.prepare(SCAN_SQL).bind('load-tour','2026-10-21','2026-10-21T10:00:00Z','','lunch',0,0,'men','123','unknown_number','123').all();
 assert.deepEqual([byTour.results[0].reason,byTour.results[0].person_id,byTour.results[0].by_tour],['admitted','large-p2479',1]);
 assert.ok(byTour.meta.rows_read<200,JSON.stringify(byTour.meta));
 const own=await f.db.prepare(SCAN_SQL).bind('load-own','2026-10-21','2026-10-21T10:01:00Z','large-p2479','lunch',0,0,'men',null,null,null).all();
 assert.deepEqual([own.results[0].reason,own.results[0].by_tour],['admitted',null]);
 assert.ok(own.meta.rows_read<300&&own.meta.rows_written<=15,JSON.stringify(own.meta));
 assert.deepEqual((await f.db.prepare("SELECT person_id,by_tour FROM admissions WHERE date='2026-10-21' AND meal='lunch' AND person_id LIKE 'large-p24%' ORDER BY person_id").all()).results,
  [{person_id:'large-p2478',by_tour:1},{person_id:'large-p2479',by_tour:0}]);
 // The next poll carries the guest's own meal as new, and today's tour-number meals in full, read through their index.
 const after=await offlineData(q,new URL(`https://x/?cards=${full.cardCursor}&admissions=${full.admissionCursor}&date=2026-10-21`),{date:'2026-10-21'},'base64');
 assert.deepEqual([after.admissions,after.tourAdmissions],[[['large-p2479','lunch']],[['large-p2478','lunch']]]);
 const tourPollReads=reads.splice(0).reduce((a,b)=>a+b,0);assert.ok(tourPollReads<20,String(tourPollReads));
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
 // 0005 only adds the offline flag, which is 0 for every earlier scan; 0006 adds the scanner, 0008 the typed card
 // number and 0009 the tour-number mark, all NULL for earlier scans.
 assert.deepEqual((await f.db.prepare('SELECT * FROM scan_logs').all()).results,before.map(r=>({...r,offline:0,gate:null,typed_code:null,by_tour:null})));
 const counts=(await f.call('/summary?date=2026-10-20')).data;
 const {gates,...totals}=counts;
 assert.deepEqual(totals,{date:'2026-10-20',breakfast:0,lunch:0,dinner:0,other:2,scans:2});
 // Scans from before the scanner split have none recorded, and the split still adds up to the total.
 assert.deepEqual([gates.men.scans,gates.women.scans,gates.none.other,gates.none.scans],[0,0,2,2]);
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await f.close();}
});

test('Cloudflare: stays end on departure, offline scans, the phone card list and the tour report',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),b=await f.issue(t.id),[one,two]=b.cards;
 // The phone's list holds base64 card hashes and no office names.
 const full=(await f.call('/scanner/data',undefined,'scanner')).data;
 assert.equal(full.hash,'base64');assert.deepEqual(full.cards.map(c=>c[0]).sort(),[await hash(one.token),await hash(two.token)].sort());assert.ok(!JSON.stringify(full).includes('Test office'));
 assert.equal(full.extensions,undefined);
 // Extending a stay is no longer offered.
 assert.equal((await f.call(`/tours/${t.id}/extensions`,{date:'2026-10-25',meals:'lunch'})).status,404);
 f.setTime('2026-10-24T10:00:00Z');const green=await f.scan(one.token);assert.equal(green.data.status,'green');
 const dup=await f.scan(one.token);assert.equal(dup.data.reason,'already_scanned');assert.equal(dup.data.firstScannedAt,green.data.scanned_at);
 f.setTime('2026-10-25T10:00:00Z');const ended=await f.scan(one.token);assert.deepEqual([ended.data.reason,ended.data.message],['after_departure','Stay has ended']);
 // An offline phone's lunch scan from yesterday is counted for yesterday.
 const offline=await f.call('/scan',{code:'MW1:'+two.token,requestKey:randomUUID(),offlineAt:'2026-10-24T09:30:00Z',offlineStatus:'green'},'scanner');
 assert.deepEqual([offline.data.reason,offline.data.date,offline.data.meal,offline.data.offline],['admitted','2026-10-24','lunch',1]);
 const declined=await f.call('/scan',{code:'MW1:'+two.token,requestKey:randomUUID(),offlineAt:'2026-10-21T09:30:00Z',offlineStatus:'green'},'scanner');assert.equal(declined.status,400);
 const report=(await f.call('/summary/tours?date=2026-10-24')).data;
 assert.deepEqual(report.map(r=>[r.tour_id,r.breakfast,r.lunch,r.dinner]),[['26/1',0,2,0]]);
 assert.equal((await f.call('/summary?date=2026-10-24')).data.lunch,2);
 assert.equal((await f.call('/archive/extensions?before=2026-10-25')).status,404);
 }finally{await f.close();}
});

test('Cloudflare: scans record the men’s or women’s scanner and the scan log counts each',async()=>{
 const f=await fixture();try{
 const t=await f.tour(2),b=await f.issue(t.id);f.setTime('2026-10-21T09:30:00Z');
 const scan=(token,gate)=>f.call('/scan',{code:'MW1:'+token,requestKey:randomUUID(),gate},'scanner');
 assert.equal((await scan(b.cards[0].token,'men')).data.gate,'men');assert.equal((await scan(b.cards[1].token,'women')).data.gate,'women');
 assert.equal((await scan(b.cards[1].token,'men')).data.reason,'already_scanned');
 assert.equal((await scan('x','women-gate')).status,400);
 const counts=(await f.call('/logs/gates?date=2026-10-21')).data;
 assert.deepEqual([counts.men.admitted,counts.men.declined,counts.women.admitted,counts.women.lunch,counts.none.scans],[1,1,1,1,0]);
 assert.deepEqual((await f.call('/logs?date=2026-10-21&gate=men')).data.map(r=>r.reason),['already_scanned','admitted']);
 assert.equal((await f.call('/logs/gates?date=2026-10-21',undefined,'scanner')).status,401);
 const summary=(await f.call('/summary?date=2026-10-21')).data;
 assert.deepEqual([summary.lunch,summary.gates.men.lunch,summary.gates.women.lunch,summary.gates.none.scans],[2,1,1,0]);
 assert.deepEqual((await f.call('/summary/tours?date=2026-10-21&gate=women')).data.map(t=>[t.tour_id,t.lunch]),[['26/1',1]]);
 assert.deepEqual((await f.call('/summary/tours?date=2026-10-21')).data.map(t=>[t.tour_id,t.lunch]),[['26/1',2]]);
 }finally{await f.close();}
});

test('Cloudflare: cards are numbered when printed and a typed number is checked like the QR',async(ctx)=>{
 const f=await fixture();try{
 const t=await f.tour(2),b=await f.issue(t.id);
 // The sealed manifest the printing computer draws from carries each card's number.
 assert.deepEqual(b.cards.map(c=>[c.sticker_no,c.sticker_tour]),[[1,'1'],[2,'1']]);
 assert.deepEqual((await f.call(`/batches/${b.id}/manifest`)).data.cards.map(c=>c.sticker_no),[1,2]);
 // Lost cards added under the same tour ID while it is staying continue the numbers.
 const extra=await f.tour(1,{office:'',arrival:'2026-10-22'}),e=await f.issue(extra.id);
 assert.deepEqual(e.cards.map(c=>[c.person_no,c.sticker_no]),[[1,3]]);
 f.setTime('2026-10-22T10:00:00Z');
 const typed=(number,extra={})=>f.call('/scan',{number,requestKey:randomUUID(),...extra},'scanner');
 const green=await typed('031',{gate:'men'});
 assert.deepEqual([green.data.status,green.data.reason,green.data.person_id,green.data.typed_code],['green','admitted',e.cards[0].person_id,'031']);
 assert.equal((await f.scan(e.cards[0].token)).data.reason,'already_scanned');
 assert.equal((await typed('041')).data.reason,'unknown_number');assert.equal((await typed('x')).status,400);
 // Gate phones get each card's number for checking offline.
 const list=(await f.call('/scanner/data',undefined,'scanner')).data;
 assert.deepEqual(list.cards.map(c=>c.slice(5)).sort(),[[1,'1'],[2,'1'],[3,'1']]);
 // Two computers printing for the same tour at the same moment never print the same number: a job that would is
 // refused as a whole (409) and prints correctly when tried again.
 const stays=[];for(let n=0;n<4;n++)stays.push(await f.tour(3,{office:'',arrival:'2026-10-23'}));
 const jobs=await Promise.all(stays.map(s=>f.call('/labels',{tourIds:[s.id],requestKey:randomUUID()})));
 assert.ok(jobs.every(j=>[201,409].includes(j.status)),JSON.stringify(jobs.map(j=>j.status)));
 for(const [n,job] of jobs.entries())if(job.status===409){assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM people WHERE tour_id=?').bind(stays[n].id).first()).n,0,'nothing from a refused job is kept');await f.issue(stays[n].id);}
 const all=(await f.db.prepare("SELECT sticker_no FROM people WHERE sticker_tour='1' ORDER BY sticker_no").all()).results.map(r=>r.sticker_no);
 assert.deepEqual(all,Array.from({length:15},(_,i)=>i+1),'every overlapping card has its own number');
 // The database itself refuses a duplicate.
 const spare=await f.tour(1,{office:'',arrival:'2026-10-23'});
 await assert.rejects(f.db.prepare("INSERT INTO people(id,tour_id,person_no,sticker_no,sticker_tour) VALUES('rival',?,1,4,'1')").bind(spare.id).run(),/duplicate_sticker_no/);
 ctx.diagnostic(JSON.stringify(jobs.map(j=>j.status)));
 }finally{await f.close();}
});

test('Cloudflare: migration 0008 numbers people printed earlier without touching their stays',async()=>{
 const f=await fixture({},MIGRATIONS.slice(0,7));try{
 await f.db.batch([`INSERT INTO tours(id,tour_id,shared_tour_id,office,arrival,departure,pax,created_at) VALUES('sheet','26/5253',NULL,'A','2026-10-21','2026-10-24',2,'x'),('shared',NULL,'26/5253','A','2026-10-21','2026-10-24',1,'x'),('legacy','2938',NULL,'A','2026-10-21','2026-10-24',1,'x'),('named','MAIMOON TOUR',NULL,'A','2026-10-21','2026-10-24',1,'x'),('short','26/5',NULL,'A','2026-10-21','2026-10-24',1,'x')`,
  `INSERT INTO people(id,tour_id,person_no) VALUES('s1','sheet',1),('s2','sheet',2),('x1','shared',1),('l1','legacy',1),('n1','named',1),('h1','short',1)`].map(sql=>f.db.prepare(sql)));
 const before=(await f.db.prepare('SELECT * FROM tours ORDER BY id').all()).results;
 await f.db.batch(statements('0008_card_numbers.sql').map(sql=>f.db.prepare(sql)));
 assert.deepEqual((await f.db.prepare('SELECT id,sticker_no,sticker_tour FROM people ORDER BY id').all()).results,
  [{id:'h1',sticker_no:1,sticker_tour:'5'},{id:'l1',sticker_no:1,sticker_tour:'2938'},{id:'n1',sticker_no:null,sticker_tour:null},{id:'s1',sticker_no:1,sticker_tour:'5253'},{id:'s2',sticker_no:2,sticker_tour:'5253'},{id:'x1',sticker_no:null,sticker_tour:null}]);
 assert.deepEqual((await f.db.prepare('SELECT * FROM tours ORDER BY id').all()).results,before);
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await f.close();}
});

test('Cloudflare: a tour arriving in Karbala at night, on the next day\'s Pehli, eats dinner the day it arrives (NKERP)',async()=>{
 // NKERP as it answered for 26/2291 on 20 November 2026: Karbala arrival 8:45 pm, departure 25 November.
 const visit={Id:59519000,TourId:428790700,ArrivalDate:'2026-11-20T20:45:00',DepartureDate:'2026-11-25T08:00:00',Tour:{ReferenceNo:'NKERP/TOUR/2026/2291',PaxCount:2}};
 let nkerpUp=true;const seen=[];
 const nkerp=async request=>{
  const path=new URL(request.url).pathname;seen.push(path);
  if(!nkerpUp)return new Response('down',{status:503});
  if(path.endsWith('/api/accounts/Login'))return Response.json({ReturnStatus:true,IsAuthenicated:true,UserId:77,Role:'13'},{headers:{'Set-Cookie':'.ASPXAUTH=abc; path=/'}});
  if(!(request.headers.get('Cookie')||'').includes('.ASPXAUTH=abc'))return new Response('expired',{status:401});
  if(path.includes('GetSectionIdByGroupId'))return Response.json({});
  const rows=path.endsWith('getReleasedTours')?[visit]:[];return Response.json({lstMufiquaFinalInZSDTO:rows,TotalRows:rows.length});
 };
 const f=await fixture({NKERP_LOGIN_ID:'id',NKERP_PASSWORD:'pw'},MIGRATIONS,nkerp);try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const sync=tours=>f.call('/sync/tours',{...source,tours},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}});
 const pehli={tour_id:'26/2291',office:'FH Mumbai',arrival:'2026-11-21',departure:'2026-11-25',pax:2};
 f.setTime('2026-11-20T10:00:00Z');
 // Before NKERP has been read, the Sheet's Pehli is the arrival: the bug this fixes.
 assert.equal((await sync([pehli])).status,200);
 const stay=(await f.call('/tours?date=')).data.find(t=>t.tour_id==='26/2291');assert.equal(stay.arrival,'2026-11-21');
 const cards=(await f.issue(stay.id)).cards;
 f.setTime('2026-11-20T17:00:00Z');assert.equal((await f.scan(cards[0].token)).data.reason,'before_arrival');
 // The ten-minute job reads NKERP, moves the stay to its arrival day at once (even if the Sheet is not syncing), and asks
 // the Sheet to sync again.
 const worker=await f.mf.getWorker();
 await worker.scheduled({scheduledTime:new Date('2026-11-20T17:00:00Z'),cron:'*/10 * * * *'});
 const stored=JSON.parse((await f.db.prepare("SELECT value FROM settings WHERE key='nkerp'").first()).value);
 assert.deepEqual(stored.visits,[['26/2291','2026-11-20T20:45','2026-11-25']]);
 assert.equal(JSON.parse((await f.db.prepare("SELECT value FROM settings WHERE key='syncRequestedAt'").first()).value),'2026-11-20T17:00:00.000Z');
 assert.ok(seen.some(p=>p.endsWith('/api/accounts/Login')));
 const sealed=(await f.db.prepare("SELECT value FROM settings WHERE key='nkerpSession'").first()).value;assert.equal(sealed.includes('abc'),false);
 assert.deepEqual((await f.call('/settings')).data.nkerpMoved.stays,['26/2291 arrived 2026-11-20 20:45; moved from 2026-11-21 to 2026-11-20']);
 assert.equal((await f.scan(cards[0].token)).data.status,'green');
 // The Sheet's next sync agrees: same stay, same cards, nothing to change.
 assert.equal((await sync([pehli])).data.changedTours,0);
 const moved=(await f.call('/tours?date=')).data.filter(t=>t.tour_id==='26/2291');
 assert.deepEqual(moved.map(t=>[t.id,t.arrival,t.departure,t.pax]),[[stay.id,'2026-11-20','2026-11-25',2]]);
 assert.equal((await f.scan(cards[1].token)).data.reason,'admitted');
 const settings=(await f.call('/settings')).data;
 assert.deepEqual(settings.sync.corrected,['26/2291 arrived 2026-11-20 20:45; Sheet Pehli 2026-11-21']);
 assert.equal(settings.nkerp.visits,1);assert.equal(settings.nkerp.configured,true);assert.equal(settings.nkerpError,null);
 // The next run reuses the session (no sign-in); unchanged arrivals do not ask the Sheet again.
 const logins=seen.filter(p=>p.endsWith('/api/accounts/Login')).length;
 await worker.scheduled({scheduledTime:new Date('2026-11-20T17:10:00Z'),cron:'*/10 * * * *'});
 assert.equal(seen.filter(p=>p.endsWith('/api/accounts/Login')).length,logins);
 assert.equal(JSON.parse((await f.db.prepare("SELECT value FROM settings WHERE key='syncRequestedAt'").first()).value),'2026-11-20T17:00:00.000Z');
 assert.equal((await sync([pehli])).data.changedTours,0);
 // A stay that would overlap another stay of the same tour ID is not moved by the job.
 await f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active) VALUES('prev','26/4000','X','2026-11-15','2026-11-20',1,'sheets','k1','2026-11-01',1),('next','26/4000','X','2026-11-21','2026-11-25',1,'sheets',?,'2026-11-01',1)").bind(`${source.spreadsheetId}|Tours|26/4000|2026-11-21`).run();
 visit.Tour.ReferenceNo='NKERP/TOUR/2026/4000';
 await worker.scheduled({scheduledTime:new Date('2026-11-20T17:15:00Z'),cron:'*/10 * * * *'});
 assert.equal((await f.db.prepare("SELECT arrival FROM tours WHERE id='next'").first()).arrival,'2026-11-21');
 assert.equal((await f.db.prepare("SELECT value FROM settings WHERE key='nkerpError'").first()),null);
 // A tour with no cards printed also starts on the arrival day, under the Sheet's source key.
 visit.Tour.ReferenceNo='NKERP/TOUR/2026/3545';visit.ArrivalDate='2026-11-20T21:05:00';
 await worker.scheduled({scheduledTime:new Date('2026-11-20T17:20:00Z'),cron:'*/10 * * * *'});
 await sync([pehli,{...pehli,tour_id:'26/3545',pax:4}]);
 const fresh=(await f.db.prepare("SELECT arrival,source_key FROM tours WHERE tour_id='26/3545'").first());
 assert.deepEqual(fresh,{arrival:'2026-11-20',source_key:`${source.spreadsheetId}|Tours|26/3545|2026-11-21`});
 // 26/2291 is gone from NKERP's answer now: its printed cards keep the arrival day they were moved to.
 assert.equal((await f.db.prepare("SELECT arrival FROM tours WHERE tour_id='26/2291'").first()).arrival,'2026-11-20');
 // NKERP down: the last good arrivals stay in use and Settings shows the failure.
 nkerpUp=false;await worker.scheduled({scheduledTime:new Date('2026-11-20T17:30:00Z'),cron:'*/10 * * * *'});
 const down=(await f.call('/settings')).data;assert.match(down.nkerpError.message,/HTTP 503/);assert.equal(down.nkerp.visits,1);
 await sync([pehli,{...pehli,tour_id:'26/3545',pax:5}]);
 assert.equal((await f.db.prepare("SELECT arrival FROM tours WHERE tour_id='26/3545'").first()).arrival,'2026-11-20');
 }finally{await f.close();}
});

test('Cloudflare: without NKERP secrets the job does nothing and Sheet arrivals are used',async()=>{
 const f=await fixture();try{
 const worker=await f.mf.getWorker();await worker.scheduled({scheduledTime:new Date('2026-11-20T17:00:00Z'),cron:'*/10 * * * *'});
 assert.equal(await f.db.prepare("SELECT value FROM settings WHERE key IN ('nkerp','nkerpError')").first(),null);
 assert.equal((await f.call('/settings')).data.nkerp.configured,false);
 }finally{await f.close();}
});

// Guests turned away live (20–23 November 2026) although their tour was in Karbala; see test/false-red.test.js.
test('Cloudflare: a guest is let in while NKERP or another stay of the tour puts it in Karbala; mistyped numbers are found',async()=>{
 const f=await fixture();try{
 const december=await f.tour(3,{tour_id:'26/3449',arrival:'2026-12-17',departure:'2026-12-22'});await f.issue(december.id);
 const typed=number=>f.call('/scan',{number,requestKey:randomUUID()},'scanner');
 f.setTime('2026-10-22T10:00:00Z');
 assert.equal((await typed('013449')).data.reason,'before_arrival');
 await f.db.prepare("INSERT INTO settings(key,value) VALUES('nkerp',?)").bind(JSON.stringify({visits:[['26/3449','2026-10-20T15:10','2026-10-24']]})).run();
 assert.deepEqual([(await typed('013449')).data.status,(await typed('023449')).data.reason],['green','admitted']);
 // The leading zero left off: 23500 for card 023500, of a stay covering the day.
 const current=await f.tour(2,{tour_id:'26/3500'});await f.issue(current.id);
 const r=await typed('23500');assert.deepEqual([r.data.status,r.data.reason,r.data.typed_code],['green','admitted','23500']);
 assert.equal((await typed('023500')).data.reason,'already_scanned');
 await f.db.prepare('UPDATE tours SET active=0 WHERE id=?').bind(december.id).run();
 assert.equal((await typed('033449')).data.reason,'admitted');
 f.setTime('2026-10-25T10:00:00Z');
 assert.equal((await typed('013449')).data.reason,'inactive_tour');
 // Another active stay under the same tour ID covering the day lets the December card in too.
 await f.db.prepare('UPDATE tours SET active=1 WHERE id=?').bind(december.id).run();
 await f.call('/tours',{tour_id:'26/3449',office:'',arrival:'2026-10-25',departure:'2026-10-27',pax:1});
 assert.equal((await typed('023449')).data.reason,'admitted');
 const stay=(await f.call('/scanner/data',undefined,'scanner')).data.tours.find(t=>t[0]===december.id);
 assert.deepEqual(stay[5],[['2026-10-25','2026-10-27'],['2026-12-17','2026-12-22']]);
 }finally{await f.close();}
});

test('Cloudflare: the Apps Script reports a sync it could not finish, and Settings shows it',async()=>{
 const f=await fixture();try{
 assert.equal((await f.call('/sync/error',{message:'x'},'none',{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await f.call('/sync/error',{message:'Source columns do not match the arrival/departure headers'},'none',{headers:{Authorization:`Bearer ${config.SYNC_TOKEN}`}})).status,200);
 assert.match((await f.call('/settings')).data.syncError.message,/^Google Sheet: Source columns do not match/);
 }finally{await f.close();}
});
