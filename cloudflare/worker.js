import { serviceAt, validateTour, validateSafari, validateExtension, TIME_ZONE, START_DATE } from '../src/rules.js';
import { SCAN_SQL, FIRST_ADMISSION_SQL, SCAN_REASONS as reasons, offlineTime } from '../src/scan-query.js';
import { SUMMARY_SQL, OUTSIDE_SQL, outsideCounts, TOUR_REPORT_SQL, EXTENSIONS_SQL } from '../src/summary.js';
import { offlineData } from '../src/offline.js';
import { hash, randomToken, equal, seal, unseal } from './crypto.js';
import { tourList, safariList, scanLogQuery, BATCH_LIST_SQL } from '../src/list-queries.js';
import { ARCHIVE_DATASETS, archiveSql, archiveCutoff, archivePage, cleanupDay, CLEAR_ROWS, CLEAR_PDFS, CLEANUP_WRITE_BUDGET, CLEANUP_CHUNK_WRITES } from '../src/archive.js';
export const MAX_LABELS = 100;
const DEFAULT_PRINTER={widthMm:76.2,heightMm:50.8,name:'ZDesigner ZD220-203dpi ZPL',confirmed:true};
const DEFAULT_SOURCE={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',dailyTimes:[]};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const json=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const first=(db,sql,...args)=>stmt(db,sql,...args).first();
const all=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results;
const run=(db,sql,...args)=>stmt(db,sql,...args).run();
const keyValid=value=>typeof value==='string'&&/^[\w-]{16,100}$/.test(value);
const getSetting=async(db,key,fallback)=>{const r=await first(db,'SELECT value FROM settings WHERE key=?',key);return r?JSON.parse(r.value):fallback;};
const settingStmt=(db,key,value)=>stmt(db,'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));
function headers(response){
 const h=new Headers(response.headers);
 h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','same-origin');h.set('X-Frame-Options','SAMEORIGIN');
 h.set('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
 h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss://localhost:* ws://localhost:*; media-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
 return new Response(response.body,{status:response.status,headers:h});
}
async function boundedBody(request,max=3_000_000,raw=false){
 const reader=request.body?.getReader();if(!reader)return raw?new Uint8Array():{};
 let total=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>max){await reader.cancel();throw fail('Request is too large.',413);}chunks.push(value);}
 const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 if(raw)return data;
 try{const parsed=JSON.parse(new TextDecoder().decode(data));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();return parsed;}catch{throw fail('Send a JSON object.');}
}
// Only the administrator signs in. The scanner needs no session; older scanner sessions no longer count.
async function authorized(request,db){
 const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mawayid_session='))?.slice(16);
 if(!cookie||cookie.length>100)throw fail('Please sign in.',401);
 if(!await first(db,"SELECT 1 FROM sessions WHERE hash=? AND expires>? AND role='admin'",await hash(cookie),Date.now()))throw fail('Please sign in.',401);
}
async function requireSync(request,env){if(!await equal(request.headers.get('Authorization')||'',`Bearer ${env.SYNC_TOKEN}`,env.SYNC_TOKEN))throw fail('Invalid sync token.',401);}
export async function handleRequest(request,env,clock=()=>new Date()){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!path.startsWith('/api/')){
  if(!env.ASSETS)return new Response('Assets not configured',{status:503});
  const target=new URL(request.url);if(path==='/'||path==='/scanner')target.pathname='/index.html';
  return env.ASSETS.fetch(new Request(target,request));
 }
 if(!env.DB)throw fail('Database is not configured.',503);
 const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
 const stamp=clock().toISOString();
 if(method!=='GET'){
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)throw fail('Unexpected request origin.',403);
  if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw fail('Cross-site request rejected.',403);
 }
 if(path==='/api/health'&&method==='GET'){await first(db,'SELECT 1');return json({status:'ok',hosting:'cloudflare-free'});}
 if(!env.ADMIN_PASSWORD||!env.SYNC_TOKEN||env.SYNC_TOKEN.length<32)throw fail('Configure the admin password and sync token before signing in.',503);
 if(path==='/api/service'&&method==='GET')return json({...serviceAt(clock()),serverTime:stamp,timezone:TIME_ZONE,startDate:START_DATE});
 // Gate phones keep a copy of current cards for checking while the connection is down (see src/offline.js).
 if(path==='/api/scanner/data'&&method==='GET')return json(await offlineData((sql,...args)=>all(db,sql,...args),url,{...serviceAt(clock()),serverTime:stamp},'base64'));
 if(path==='/api/scan'&&method==='POST')return scan(db,await boundedBody(request,2048),clock());
 if(path==='/api/login'&&method==='POST'){
  const body=await boundedBody(request,2048);
  const ip=request.headers.get('CF-Connecting-IP')||'local';const bucket=Math.floor(Date.now()/900000);
  const attempt=await first(db,'INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts',await hash(`${env.SYNC_TOKEN}:${ip}:${bucket}`),Date.now()+900000);
  if(attempt.attempts>20)throw fail('Too many sign-in attempts. Try again in 15 minutes.',429);
  if(typeof body.password!=='string'||body.password.length>256||!await equal(body.password,env.ADMIN_PASSWORD,env.SYNC_TOKEN))throw fail('Incorrect password.',401);
  const token=randomToken();await db.batch([stmt(db,'DELETE FROM sessions WHERE expires<?',Date.now()),stmt(db,'DELETE FROM login_attempts WHERE expires<?',Date.now()),stmt(db,'INSERT INTO sessions VALUES(?,?,?)',await hash(token),'admin',Date.now()+43200000)]);
  return json({role:'admin'},200,{'Set-Cookie':`mawayid_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${url.protocol==='https:'?'; Secure':''}`});
 }
 if(path==='/api/sync/config'&&method==='GET'){await requireSync(request,env);return json({...await getSetting(db,'source',DEFAULT_SOURCE),requestedAt:await getSetting(db,'syncRequestedAt',null),lastSuccess:(await getSetting(db,'sync',null))?.lastSuccess||null});}
 if(path==='/api/sync/tours'&&method==='POST'){await requireSync(request,env);return syncTours(db,await boundedBody(request),stamp);}
 await authorized(request,db);
 if(path==='/api/session'&&method==='GET')return json({role:'admin'});
 if(path==='/api/logout'&&method==='POST'){
  const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('mawayid_session='))?.slice(16);
  await run(db,'DELETE FROM sessions WHERE hash=?',await hash(cookie));return json({ok:true},200,{'Set-Cookie':'mawayid_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});
 }
 if(path==='/api/tours'&&method==='GET'){
  const arrival=url.searchParams.get('arrival')||'',q=(url.searchParams.get('q')||'').slice(0,150).toLowerCase(),sort=url.searchParams.get('sort')||'',status=url.searchParams.get('status')||'';
  const query=tourList({arrival,q,sort,status});return json(await all(db,query.sql,...query.params));
 }
 if(path==='/api/tours'&&method==='POST'){
  let t;try{t=validateTour(await boundedBody(request,8192),{requireId:false});}catch(e){throw fail(e.message);}
  const existing=t.tour_id&&await first(db,'SELECT * FROM tours WHERE tour_id=? AND arrival=?',t.tour_id,t.arrival);if(existing)return json({...existing,existing:true});
  const id=crypto.randomUUID();await run(db,'INSERT INTO tours(id,tour_id,its,office,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)',id,t.tour_id,t.its,t.office,t.arrival,t.departure,t.pax,stamp);return json({id,...t},201);
 }
 // Safari cards print without a QR code, so they have no people, cards or scans.
 if(path==='/api/safaris'&&method==='GET'){
  const arrival=url.searchParams.get('arrival')||'',q=(url.searchParams.get('q')||'').slice(0,150).toLowerCase(),sort=url.searchParams.get('sort')||'',status=url.searchParams.get('status')||'';
  const query=safariList({arrival,q,sort,status});return json(await all(db,query.sql,...query.params));
 }
 if(path==='/api/safaris'&&method==='POST'){
  let s;try{s=validateSafari(await boundedBody(request,8192));}catch(e){throw fail(e.message);}
  const row={id:crypto.randomUUID(),...s,created_at:stamp};
  await run(db,'INSERT INTO safaris(id,office,tour_id,its,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)',...Object.values(row));return json(row,201);
 }
 // The printing computer draws Safari stickers and saves the PDF here before printing, so the job appears in Print log.
 if(path==='/api/safaris/print'&&method==='POST'){
  const key=url.searchParams.get('requestKey'),ids=[...new Set((url.searchParams.get('ids')||'').split(',').filter(Boolean))];
  if(!keyValid(key))throw fail('A valid request key is required.');
  if(!ids.length||ids.length>MAX_LABELS||ids.some(id=>!/^[\w-]{1,100}$/.test(id)))throw fail(`Select up to ${MAX_LABELS} Safari cards per print job.`);
  const prior=await first(db,'SELECT id FROM batches WHERE request_key=?',key);if(prior)return json({id:prior.id,existing:true});
  const data=await boundedBody(request,1_500_000,true);
  if(new TextDecoder().decode(data.slice(0,5))!=='%PDF-'||!new TextDecoder().decode(data.slice(-100)).includes('%%EOF'))throw fail('Upload a generated PDF.');
  if((await first(db,'SELECT COUNT(*) AS n FROM safaris WHERE id IN(SELECT value FROM json_each(?))',JSON.stringify(ids))).n!==ids.length)throw fail('Safari card not found.',404);
  const id=crypto.randomUUID();
  try{await db.batch([stmt(db,"INSERT INTO batches(id,created_at,kind,request_key,pdf,printer_status) VALUES(?,?,'safari',?,?,'generated')",id,stamp,key,data.buffer),stmt(db,'INSERT INTO safari_prints(batch_id,safari_id) SELECT ?,value FROM json_each(?)',id,JSON.stringify(ids))]);}
  catch(error){const existing=await first(db,'SELECT id FROM batches WHERE request_key=?',key);if(existing)return json({id:existing.id,existing:true});throw error;}
  return json({id,count:ids.length},201);
 }
 // Extending a stay adds meals after departure on the same QR cards; changes keep their history.
 const extension=path.match(/^\/api\/tours\/([\w-]+)\/extensions$/);
 if(extension&&method==='GET')return json(await all(db,EXTENSIONS_SQL,extension[1]));
 if(extension&&method==='POST'){
  const body=await boundedBody(request,1024),tour=await first(db,'SELECT id,departure,active FROM tours WHERE id=?',extension[1]);
  let x;try{x=validateExtension(body,tour,serviceAt(clock()).date);}catch(e){throw fail(e.message,e.status);}
  const current=await first(db,'SELECT * FROM tour_extensions WHERE tour_id=? AND date=? AND removed_at IS NULL',tour.id,x.date);
  if(current?.meals===x.meals)return json({...current,existing:true});
  const row={id:crypto.randomUUID(),tour_id:tour.id,date:x.date,meals:x.meals,created_at:stamp};
  await db.batch([stmt(db,'UPDATE tour_extensions SET removed_at=? WHERE tour_id=? AND date=? AND removed_at IS NULL',stamp,tour.id,x.date),stmt(db,'INSERT INTO tour_extensions(id,tour_id,date,meals,created_at) VALUES(?,?,?,?,?)',...Object.values(row))]);
  return json(row,201);
 }
 const removeExtension=path.match(/^\/api\/extensions\/([\w-]+)\/remove$/);
 if(removeExtension&&method==='POST'){
  const result=await run(db,'UPDATE tour_extensions SET removed_at=? WHERE id=? AND removed_at IS NULL',stamp,removeExtension[1]);
  if(!result.meta?.changes)throw fail('This extension was already removed.',404);return json({ok:true});
 }
 const people=path.match(/^\/api\/tours\/([\w-]+)\/people$/);
 if(people&&method==='GET')return json(await all(db,'SELECT p.id,p.person_no,c.id AS card_id,c.created_at FROM people p LEFT JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL WHERE p.tour_id=? ORDER BY p.person_no',people[1]));
 if(path==='/api/labels'&&method==='POST')return issueLabels(db,await boundedBody(request,100000),env,stamp);
 if(path==='/api/batches'&&method==='GET')return json(await all(db,BATCH_LIST_SQL));
 const batchPath=path.match(/^\/api\/batches\/([\w-]+)\/(pdf|manifest|status)$/);
 if(batchPath){
  const [,id,action]=batchPath;
  if(action==='pdf'&&method==='GET'){
   const row=await first(db,'SELECT pdf,printer_status FROM batches WHERE id=?',id);
   if(row?.printer_status==='pdf_cleared')throw fail('This label PDF was cleared after the stay ended. Use Replace cards if a guest still needs a card.',410);
   if(!row?.pdf)throw fail('The label PDF still needs to be generated. Use Finish PDF in Print log.',409);
   return new Response(new Uint8Array(row.pdf),{headers:{'Content-Type':'application/pdf','Content-Disposition':`inline; filename="mawaid-${id}.pdf"`,'Cache-Control':'no-store'}});
  }
  if(action==='pdf'&&method==='POST'){
   const data=await boundedBody(request,1_500_000,true);
   if(new TextDecoder().decode(data.slice(0,5))!=='%PDF-'||!new TextDecoder().decode(data.slice(-100)).includes('%%EOF'))throw fail('Upload a generated PDF.');
   const exists=await first(db,'SELECT id FROM batches WHERE id=?',id);if(!exists)throw fail('Batch not found.',404);
   await run(db,"UPDATE batches SET pdf=?,envelope=NULL,printer_status='generated' WHERE id=? AND pdf IS NULL",data.buffer,id);return json({ok:true});
  }
  if(action==='manifest'&&method==='GET')return json(await batchManifest(db,id,env));
  if(action==='status'&&method==='POST'){
   const body=await boundedBody(request,2048);if(!['sent_to_printer','printer_error'].includes(body.status))throw fail('Invalid printer status.');
   await run(db,'UPDATE batches SET printer_status=? WHERE id=? AND pdf IS NOT NULL',body.status,id);return json({ok:true});
  }
 }
 if(path==='/api/logs'&&method==='GET'){
  const get=k=>(url.searchParams.get(k)||'').slice(0,160),date=get('date'),tour=get('tour').toLowerCase(),office=get('office').toLowerCase(),status=get('status');
  const query=scanLogQuery({date,tour,office,status});return json(await all(db,query.sql,...query.params));
 }
 if(path==='/api/summary'&&method==='GET'){
  const date=url.searchParams.get('date')||serviceAt(clock()).date;
  return json({...await first(db,SUMMARY_SQL,date),outside:outsideCounts(await all(db,OUTSIDE_SQL,date))});
 }
 if(path==='/api/summary/tours'&&method==='GET')return json(await all(db,TOUR_REPORT_SQL,url.searchParams.get('date')||serviceAt(clock()).date));
 if(path==='/api/settings'&&method==='GET'){
  const info=await stmt(db,'SELECT 1').all();return json({printer:await getSetting(db,'printer',DEFAULT_PRINTER),source:await getSetting(db,'source',DEFAULT_SOURCE),sync:await getSetting(db,'sync',null),timeZone:TIME_ZONE,hosting:'cloudflare-free',maxLabels:MAX_LABELS,databaseBytes:info.meta?.size_after||0,databaseLimitBytes:500_000_000});
 }
 if(path==='/api/settings'&&method==='POST'){
  const body=await boundedBody(request,8192),statements=[];
  if(body.printer){const p=body.printer;if(![p.widthMm,p.heightMm].every(n=>typeof n==='number'&&Number.isFinite(n))||p.widthMm<40||p.widthMm>104||p.heightMm<50.8||p.heightMm>200||(p.heightMm<80&&p.widthMm<70)||typeof p.name!=='string'||!p.name.trim()||p.name.length>150)throw fail('Enter a supported label size and printer name.');statements.push(settingStmt(db,'printer',{widthMm:p.widthMm,heightMm:p.heightMm,name:p.name,confirmed:true}));}
  if(body.source){const s=body.source;if(!/^[\w-]{20,100}$/.test(s.spreadsheetId)||typeof s.tab!=='string'||!s.tab.trim()||s.tab.length>100)throw fail('Enter a valid spreadsheet URL and tab name.');const times=s.dailyTimes||[];if(!Array.isArray(times)||times.length>24||times.some(t=>typeof t!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))throw fail('Daily times must use HH:mm.');statements.push(settingStmt(db,'source',{spreadsheetId:s.spreadsheetId,tab:s.tab.trim(),dailyTimes:[...new Set(times)].sort()}));}
  if(statements.length)await db.batch(statements);return json({ok:true});
 }
 if(path==='/api/archive'&&method==='GET'){
  const today=serviceAt(clock()).date,before=archiveCutoff(url.searchParams.get('before')||today,today);
  const counts=await first(db,archiveSql(true).counts,before),info=await stmt(db,'SELECT 1').all();
  return json({before,today,counts,databaseBytes:info.meta?.size_after||0,databaseLimitBytes:500_000_000,cleanup:await cleanupUsage(db,clock())});
 }
 const dataset=path.match(/^\/api\/archive\/(scans|meals|tours|cards|prints|extensions)$/);
 if(dataset&&method==='GET'){
  const today=serviceAt(clock()).date,before=archiveCutoff(url.searchParams.get('before')||today,today),{after,limit}=archivePage(url);
  const rows=await all(db,ARCHIVE_DATASETS[dataset[1]],before,after,limit);
  return json({rows,next:rows.length===limit?rows.at(-1).cursor:null});
 }
 if(path==='/api/archive/clear'&&method==='POST')return clearArchived(db,await boundedBody(request,1024),clock());
 if(path==='/api/sync/request'&&method==='POST'){await settingStmt(db,'syncRequestedAt',stamp).run();return json({ok:true});}
 throw fail('Not found.',404);
}
async function scan(db,body,now){
 if(!keyValid(body.requestKey))throw fail('A scan request key is required.');
 if(typeof body.code!=='string'||body.code.length>300)throw fail('Invalid QR code.');
 // A scan made on an offline phone is checked as at the time it was made.
 const offlineAt=offlineTime(body,now),at=offlineAt||now;
 const service=serviceAt(at),codeHash=body.code.startsWith('MW1:')?await hash(body.code.slice(4)):'';
 // Eligibility, duplicate check, log and admission trigger run atomically on the primary.
 const row=await first(db,SCAN_SQL,body.requestKey,service.date,at.toISOString(),codeHash,service.meal,offlineAt?1:0,offlineAt&&body.offlineStatus==='red'?1:0);
 const result=row||await first(db,'SELECT * FROM scan_logs WHERE request_key=?',body.requestKey);
 const replayed=!row,earlier=result.reason==='already_scanned'?await first(db,FIRST_ADMISSION_SQL,result.person_id,result.date,result.meal):null;
 return json({...result,replayed,firstScannedAt:earlier?.scanned_at||null,status:result.reason==='admitted'&&!replayed?'green':'red',message:replayed?'Request already processed — check the scan log before admitting':reasons[result.reason],serverTime:now.toISOString()});
}
async function batchManifest(db,id,env){
 const row=await first(db,'SELECT id,envelope,pdf IS NOT NULL AS pdf_ready,remaining FROM batches WHERE id=?',id);
 if(!row)throw fail('Batch not found.',404);
 return {id:row.id,remaining:row.remaining,requiresPdfUpload:!row.pdf_ready,...(row.envelope?await unseal(row.envelope,env.SYNC_TOKEN):{})};
}
async function issueLabels(db,body,env,stamp){
 if(!keyValid(body.requestKey))throw fail('A valid request key is required.');
 const prior=await first(db,'SELECT id FROM batches WHERE request_key=?',body.requestKey);if(prior)return json({...await batchManifest(db,prior.id,env),existing:true});
 const printer=await getSetting(db,'printer',DEFAULT_PRINTER);if(!printer.confirmed)throw fail('Confirm label dimensions in Settings.');
 const mode=body.personIds?'replacement':'initial',selected=mode==='replacement'?body.personIds:body.tourIds;
 if(!Array.isArray(selected)||!selected.length||selected.length>500||selected.some(id=>typeof id!=='string'||id.length>100))throw fail('Select valid tours or people.');
 const ids=[...new Set(selected)];if(mode==='replacement'&&ids.length>MAX_LABELS)throw fail(`Choose up to ${MAX_LABELS} replacements per print job. There is no lifetime replacement cap.`);
 const rows=mode==='replacement'?await all(db,`SELECT p.id AS person_id,p.person_no,t.id AS tour_key,t.tour_id,t.office,t.arrival,t.departure,t.pax,t.active,c.id AS previous_card FROM people p JOIN tours t ON t.id=p.tour_id LEFT JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL WHERE p.id IN(SELECT value FROM json_each(?))`,JSON.stringify(ids)):
 await all(db,`SELECT t.id AS tour_key,t.tour_id,t.office,t.arrival,t.departure,t.pax,t.active,(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued FROM tours t WHERE t.id IN(SELECT value FROM json_each(?)) ORDER BY t.arrival,t.tour_id`,JSON.stringify(ids));
 if(rows.length!==ids.length)throw fail('Tour or person not found.',404);
 const cards=[];let remaining=0;
 for(const r of rows){
  if(!r.active)throw fail('This source tour is no longer active.');
  if(mode==='replacement'){
   if(!r.previous_card||r.person_no>r.pax)throw fail('This person does not have a current entitlement.',409);
   if(!body.expectedCardIds||body.expectedCardIds[r.person_id]!==r.previous_card)throw fail('This card changed since the replacement list was opened. Refresh it before trying again.',409);
   cards.push({...r,id:crypto.randomUUID(),token:randomToken(),printed_at:stamp});
  }else{
   const missing=Math.max(0,r.pax-r.issued);remaining+=missing;
   for(let n=r.issued+1;n<=r.pax&&cards.length<MAX_LABELS;n++)cards.push({...r,id:crypto.randomUUID(),person_id:crypto.randomUUID(),person_no:n,token:randomToken(),printed_at:stamp});
  }
 }
 if(!cards.length)throw fail('All selected people already have cards. Use Print log or Replace cards.');
 remaining=Math.max(0,remaining-cards.length);
 const plan=await Promise.all(cards.map(async c=>({...c,token_hash:await hash(c.token)})));
 const id=crypto.randomUUID(),payload=JSON.stringify(plan.map(({token,...c})=>c));
 const envelope=await seal({cards,printer,count:cards.length},env.SYNC_TOKEN);
 const statements=[stmt(db,'INSERT INTO batches(id,created_at,kind,request_key,envelope,remaining) VALUES(?,?,?,?,?,?)',id,stamp,mode,body.requestKey,envelope,remaining)];
 if(mode==='initial')statements.push(stmt(db,`INSERT INTO people(id,tour_id,person_no) SELECT json_extract(value,'$.person_id'),json_extract(value,'$.tour_key'),json_extract(value,'$.person_no') FROM json_each(?)`,payload));
 else statements.push(stmt(db,`UPDATE cards SET revoked_at=? WHERE revoked_at IS NULL AND id IN(SELECT json_extract(value,'$.previous_card') FROM json_each(?))`,stamp,payload));
 statements.push(stmt(db,`INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.person_id'),?,json_extract(value,'$.token_hash'),? FROM json_each(?)`,id,stamp,payload));
 try{await db.batch(statements);}catch(error){const existing=await first(db,'SELECT id FROM batches WHERE request_key=?',body.requestKey);if(existing)return json({...await batchManifest(db,existing.id,env),existing:true});throw error;}
 return json({id,count:cards.length,remaining,cards,printer,requiresPdfUpload:true},201);
}
async function cleanupUsage(db,now){
 const day=cleanupDay(now),saved=await getSetting(db,'cleanupUsage',null);
 return{day,limit:CLEANUP_WRITE_BUDGET,used:saved?.day===day?saved.rowsWritten:0};
}
// One bounded chunk per request keeps each invocation inside the free plan's CPU and write limits.
async function clearArchived(db,body,now){
 const today=serviceAt(now).date,before=archiveCutoff(body.before,today),usage=await cleanupUsage(db,now);
 if(usage.used+CLEANUP_CHUNK_WRITES>usage.limit)throw fail('Today’s clean-up allowance is used up, so scanning keeps its share of the free plan. Continue after 3:00 am Karbala time.',429);
 const sql=archiveSql(true);
 const results=await db.batch([stmt(db,sql.clearScans,before),stmt(db,sql.clearMeals,before),stmt(db,sql.clearPdfs,before)]);
 const deleted={scans:results[0].results.length,meals:results[1].meta?.changes||0,pdfs:results[2].meta?.changes||0};
 const written=results.reduce((sum,r)=>sum+Math.max(r.meta?.rows_written||0,r.meta?.changes||0),0);
 const used=usage.used+written+1;
 await settingStmt(db,'cleanupUsage',{day:usage.day,rowsWritten:used}).run();
 return json({deleted,done:deleted.scans<CLEAR_ROWS&&deleted.meals<CLEAR_ROWS&&deleted.pdfs<CLEAR_PDFS,cleanup:{...usage,used}});
}
async function syncTours(db,body,stamp){
 const source=await getSetting(db,'source',DEFAULT_SOURCE);
 if(body.spreadsheetId!==source.spreadsheetId||body.tab!==source.tab)throw fail('Source workbook or tab does not match Settings.',409);
 if(!Array.isArray(body.tours)||body.tours.length>10000)throw fail('Invalid tours payload.');
 let tours;try{tours=body.tours.map(t=>validateTour(t)).filter(t=>t.departure>=START_DATE);}catch(e){throw fail(e.message);}
 const keys=tours.map(t=>`${t.tour_id}|${t.arrival}`);if(new Set(keys).size!==keys.length)throw fail('Duplicate tour stays in source.');
 const snapshot=await hash(JSON.stringify({source:[source.spreadsheetId,source.tab],tours:[...tours].sort((a,b)=>a.tour_id.localeCompare(b.tour_id)||a.arrival.localeCompare(b.arrival))}));
 const previous=await getSetting(db,'sync',null);
 const sync={lastSuccess:stamp,imported:tours.length,snapshot,tabs:Array.isArray(body.tabs)?body.tabs.filter(t=>typeof t==='string').slice(0,100):[],warnings:Array.isArray(body.warnings)?body.warnings.map(String).slice(0,30):[]};
 if(previous?.snapshot===snapshot){await settingStmt(db,'sync',sync).run();return json({ok:true,count:tours.length,changedTours:0});}
 const data=JSON.stringify(tours.map(t=>({...t,id:crypto.randomUUID(),source_key:`${source.spreadsheetId}|${source.tab}|${t.tour_id}|${t.arrival}`})));
 // An unchanged snapshot does not touch any tour row. Both update statements are conditional.
 const results=await db.batch([
 stmt(db,`UPDATE tours SET active=0 WHERE source='sheets' AND active=1 AND (source_key IS NULL OR source_key NOT IN(SELECT json_extract(value,'$.source_key') FROM json_each(?)))`,data),
 stmt(db,`INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active)
 SELECT json_extract(value,'$.id'),json_extract(value,'$.tour_id'),json_extract(value,'$.office'),json_extract(value,'$.arrival'),json_extract(value,'$.departure'),json_extract(value,'$.pax'),'sheets',json_extract(value,'$.source_key'),?,1 FROM json_each(?) WHERE 1
 ON CONFLICT(tour_id,arrival) DO UPDATE SET office=excluded.office,departure=excluded.departure,pax=excluded.pax,source=excluded.source,source_key=excluded.source_key,active=1
 WHERE tours.office<>excluded.office OR tours.departure<>excluded.departure OR tours.pax<>excluded.pax OR tours.source<>'sheets' OR tours.source_key IS NOT excluded.source_key OR tours.active<>1`,stamp,data),
 settingStmt(db,'sync',sync)]);
 return json({ok:true,count:tours.length,changedTours:(results[0].meta?.changes||0)+(results[1].meta?.changes||0)});
}
export async function respond(request,env,clock){
 try{return headers(await handleRequest(request,env,clock));}
 catch(error){
  const conflict=/UNIQUE constraint|invalid_person_capacity|overlapping_tour/.test(error.message);
  const status=conflict?409:(error.status||500);
  if(status>=500)console.error(JSON.stringify({message:'request_failed',path:new URL(request.url).pathname,status}));
  const message=conflict?'This record changed or overlaps another stay. Refresh before trying again.':error.status?error.message:'The request could not be completed. Admission is blocked until the server is available.';
  return headers(json({error:message},status));
 }
}
export default {fetch(request,env){return respond(request,env);}};
