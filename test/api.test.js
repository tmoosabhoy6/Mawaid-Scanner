import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture,tour,issue,scan,config,manyStays } from './helpers.js';
import { writeFileSync,mkdirSync,readFileSync } from 'node:fs';
import vm from 'node:vm';

test('50 unique cards; concurrent duplicate scans accept once; each meal resets daily',async()=>{
 const f=await fixture();try{
 const t=await tour(f,50),{batch,cards}=await issue(f,t.id);
 assert.equal(cards.length,50);assert.equal(new Set(cards.map(c=>c.token)).size,50);
 assert.ok(cards.every(c=>/^[\w-]{43}$/.test(c.token)));
 const results=await Promise.all(Array.from({length:30},()=>scan(f,cards[0].token)));
 assert.equal(results.filter(r=>r.body.status==='green').length,1);
 assert.equal(results.filter(r=>r.body.reason==='already_used').length,29);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,1);
 f.setTime('2026-10-21T09:30:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 f.setTime('2026-10-21T16:00:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 f.setTime('2026-10-22T03:30:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 const pdf=await f.admin.get(`/api/batches/${batch.id}/pdf`).expect(200);
 assert.equal(pdf.headers['content-type'],'application/pdf');assert.ok(pdf.body.length>10000);
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/50-labels.pdf`,pdf.body);writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/expected.json`,JSON.stringify(cards.map(c=>`MW1:${c.token}`)));}
 }finally{f.close();}
});

test('five lost cards preserve the 50-person meal limit and revoke originals',async()=>{
 const f=await fixture();try{
 const t=await tour(f,50),{cards}=await issue(f,t.id);
 await Promise.all(cards.slice(0,5).map(c=>scan(f,c.token)));
 const ids=cards.slice(0,5).map(c=>c.person_id);
 await f.admin.post('/api/labels').send({personIds:ids,requestKey:randomUUID()}).expect(201);
 const replacements=f.rendered.at(-1);assert.equal(replacements.length,5);
 for(const c of cards.slice(0,5))assert.equal((await scan(f,c.token)).body.reason,'replaced_card');
 for(const c of replacements)assert.equal((await scan(f,c.token)).body.reason,'already_used');
 await Promise.all(cards.slice(5).map(c=>scan(f,c.token)));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,50);
 const summary=await f.admin.get('/api/summary?date=2026-10-21').expect(200);assert.equal(summary.body[0].breakfast,50);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,50);
 }finally{f.close();}
});

test('unlimited replacement iterations; unused entitlement works on newest code only',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);let previous=cards[0];
 for(let n=0;n<12;n++){
 await f.admin.post('/api/labels').send({personIds:[previous.person_id],requestKey:randomUUID()}).expect(201);
 assert.equal((await scan(f,previous.token)).body.reason,'replaced_card');previous=f.rendered.at(-1)[0];
 }
 assert.equal((await scan(f,previous.token)).body.status,'green');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE revoked_at IS NULL').get().n,1);
 }finally{f.close();}
});

test('idempotency prevents new cards, admissions and logs on network retries',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),key=randomUUID();
 const first=await f.admin.post('/api/labels').send({tourIds:[t.id],requestKey:key}).expect(201);
 const again=await f.admin.post('/api/labels').send({tourIds:[t.id],requestKey:key}).expect(200);assert.equal(first.body.id,again.body.id);
 const card=f.rendered[0][0],scanKey=randomUUID();assert.equal((await scan(f,card.token,scanKey)).body.status,'green');
 const replay=await scan(f,card.token,scanKey);assert.equal(replay.body.status,'red');assert.equal(replay.body.replayed,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,1);
 }finally{f.close();}
});

test('two operators cannot issue overlapping initial cards or replacements',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1);
 const results=await Promise.all(Array.from({length:2},()=>f.admin.post('/api/labels').send({tourIds:[t.id],requestKey:randomUUID()})));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const person=f.db.prepare('SELECT id FROM people').get();
 const replacements=await Promise.all(Array.from({length:2},()=>f.admin.post('/api/labels').send({personIds:[person.id],requestKey:randomUUID()})));
 assert.deepEqual(replacements.map(r=>r.status).sort(),[201,409]);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE revoked_at IS NULL').get().n,1);
 }finally{f.close();}
});

test('before arrival, after departure, unknown QR and outside meal hours deny access',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);
 for(const [clock,reason] of [['2026-10-20T04:00:00Z','before_arrival'],['2026-10-24T04:00:00Z','after_departure'],['2026-10-21T06:00:00Z','outside_meal_time'],['2026-10-21T12:00:00Z','outside_meal_time'],['2026-10-21T18:30:00Z','outside_meal_time']]){
 f.setTime(clock);const r=await scan(f,cards[0].token);assert.equal(r.body.status,'red');assert.equal(r.body.reason,reason);
 }
 assert.equal((await scan(f,'unknown')).body.reason,'unknown_card');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,0);
 }finally{f.close();}
});

test('roles, CSRF, login, validation, duplicate stays and printing setup',async()=>{
 const f=await fixture();try{
 await request(f.app).get('/api/tours').expect(401);await f.scanner.get('/api/tours').expect(403);await f.scanner.get('/api/settings').expect(403);
 await f.admin.post('/api/tours').set('Origin','https://other.example').send({}).expect(403);
 await request(f.app).post('/api/login').send({role:'admin',password:'wrong'}).expect(401);
 await f.admin.post('/api/tours').send({tour_id:'x'}).expect(400);
 const t=await tour(f,2);const duplicate=await f.admin.post('/api/tours').send({...t,pax:5}).expect(200);assert.equal(duplicate.body.existing,true);assert.equal(duplicate.body.pax,2);
 const other=await tour(f,1,{arrival:'2026-11-01',departure:'2026-11-02'});assert.notEqual(other.id,t.id);
 await f.admin.post('/api/labels').send({requestKey:randomUUID()}).expect(400);
 const defaults=await f.admin.get('/api/settings').expect(200);assert.equal(defaults.body.printer.widthMm,76.2);assert.equal(defaults.body.printer.heightMm,50.8);
 f.db.prepare("INSERT INTO settings(key,value) VALUES('printer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({widthMm:76.2,heightMm:50.8,name:'Test',confirmed:false}));await f.admin.post('/api/labels').send({tourIds:[t.id],requestKey:randomUUID()}).expect(400);
 const {headers}=await f.admin.get('/');assert.ok(headers['content-security-policy'].includes("script-src 'self'"));
 await f.admin.post('/api/logout').send({}).expect(200);await f.admin.get('/api/tours').expect(401);
 }finally{f.close();}
});

test('sync is authenticated, idempotent, tab-specific; changed PAX and removed tours deny access',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours'};
 const t={tour_id:'26/1',office:'Source Office',arrival:'2026-10-20',departure:'2026-10-22',pax:2};
 const sync=payload=>request(f.app).post('/api/sync/tours').set('Authorization',`Bearer ${config.syncToken}`).send({...source,...payload});
 await request(f.app).post('/api/sync/tours').send({...source,tours:[t]}).expect(401);
 await sync({tab:'wrong',tours:[t]}).expect(409);await sync({tours:[t,t]}).expect(400);
 await sync({tours:[t],tabs:['KRB - 25','Tours']}).expect(200);await sync({tours:[t]}).expect(200);
 const records=await f.admin.get('/api/tours');assert.equal(records.body.length,1);const id=records.body[0].id;
 const {cards}=await issue(f,id);
 await sync({tours:[{...t,pax:1}]}).expect(200);assert.equal((await scan(f,cards[1].token)).body.reason,'over_capacity');
 assert.equal((await scan(f,cards[0].token)).body.status,'green');
 await sync({tours:[]}).expect(200);assert.equal((await scan(f,cards[0].token)).body.reason,'inactive_tour');
 await sync({tours:[{...t,departure:'2026-02-31'}]}).expect(400);assert.equal((await f.admin.get('/api/tours')).body.length,0);
 }finally{f.close();}
});

test('source updates an existing manual stay without adding capacity; SQL-like strings are inert',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1,{tour_id:"26/' OR 1=1 --",office:'<script>evil()</script>'});await issue(f,t.id);
 await request(f.app).post('/api/sync/tours').set('Authorization',`Bearer ${config.syncToken}`).send({spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',tours:[{...t,departure:'2026-10-24',office:'Updated source office'}]}).expect(200);
 const rows=await f.admin.get('/api/tours').query({q:"' OR 1=1"}).expect(200);assert.equal(rows.body.length,1);
 assert.equal(rows.body[0].id,t.id);assert.equal(rows.body[0].departure,'2026-10-24');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,1);
 const response=await f.admin.get('/api/logs?status=red').expect(200);assert.deepEqual(response.body,[]);
 }finally{f.close();}
});

test('large tours print in bounded jobs without imposing a total PAX/card cap',async()=>{
 const f=await fixture({renderLabels:async()=>Buffer.from('%PDF-test')});try{
 const t=await tour(f,501);const first=await issue(f,t.id);assert.equal(first.cards.length,500);assert.equal(first.batch.remaining,1);
 const second=await issue(f,t.id);assert.equal(second.cards.length,1);assert.equal(second.batch.remaining,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,501);
 }finally{f.close();}
});

test('daily sync schedule, sync request and machine config enforce permissions',async()=>{
 const f=await fixture();try{
 const source={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',dailyTimes:['06:00','12:00']};
 await f.admin.post('/api/settings').send({source}).expect(200);
 await f.admin.post('/api/settings').send({source:{...source,dailyTimes:['25:00']}}).expect(400);
 await f.scanner.post('/api/sync/request').send({}).expect(403);await f.admin.post('/api/sync/request').send({}).expect(200);
 await f.scanner.get('/api/sync/config').expect(401);
 const result=await request(f.app).get('/api/sync/config').set('Authorization',`Bearer ${config.syncToken}`).expect(200);
 assert.deepEqual(result.body.dailyTimes,['06:00','12:00']);assert.ok(result.body.requestedAt);
 }finally{f.close();}
});


test('Pehli/Wada import grants all meals on Wada plus one day, then expires',async()=>{
 const f=await fixture();try{
 const context={};vm.createContext(context);vm.runInContext(readFileSync('apps-script/ToursSync.js','utf8'),context);
 const header=Array(20).fill('');header[1]='Pehli Ziyarat';header[16]='Wada Ziyarat';
 const arrival=Array(20).fill('');arrival[1]='26/500';arrival[2]='Test office';arrival[4]='1';
 const wada=Array(20).fill('');wada[16]='26/500';wada[17]='Test office';wada[19]='1';
 const built=context.MAWAYID_buildTours([header,['Wednesday, October 21, 2026'],arrival,['Friday, October 23, 2026'],wada],context.MAWAYID_CONFIG);
 await request(f.app).post('/api/sync/tours').set('Authorization',`Bearer ${config.syncToken}`).send({spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',tours:built.tours}).expect(200);
 const tour=(await f.admin.get('/api/tours')).body[0];assert.equal(tour.departure,'2026-10-24');
 const {cards}=await issue(f,tour.id);assert.equal(cards[0].departure,'2026-10-24');
 for(const time of ['2026-10-24T03:30:00Z','2026-10-24T09:30:00Z','2026-10-24T16:00:00Z']){
 f.setTime(time);assert.equal((await scan(f,cards[0].token)).body.status,'green');
 }
 f.setTime('2026-10-25T03:30:00Z');assert.equal((await scan(f,cards[0].token)).body.reason,'after_departure');
 }finally{f.close();}
});

test('3 by 2 inch defaults and compact label validation match supported layouts',async()=>{
 const f=await fixture();try{
 f.db.prepare("DELETE FROM settings WHERE key='printer'").run();
 const defaults=(await f.admin.get('/api/settings').expect(200)).body.printer;
 assert.equal(defaults.widthMm,76.2);assert.equal(defaults.heightMm,50.8);assert.equal(defaults.confirmed,true);
 await f.admin.post('/api/settings').send({printer:{widthMm:76.2,heightMm:50.8,name:'Zebra'}}).expect(200);
 await f.admin.post('/api/settings').send({printer:{widthMm:69,heightMm:50.8,name:'Zebra'}}).expect(400);
 await f.admin.post('/api/settings').send({printer:{widthMm:76.2,heightMm:50,name:'Zebra'}}).expect(400);
 }finally{f.close();}
});

test('default tours list keeps current and upcoming stays in view past 1,000 tours; filters still reach old stays',async()=>{
 const f=await fixture();try{
 const stays=manyStays(35,40);
 await request(f.app).post('/api/sync/tours').set('Authorization',`Bearer ${config.syncToken}`).send({spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',tours:stays}).expect(200);
 f.setTime('2026-11-19T22:30:00Z'); // 01:30 on 20 November in Karbala, still 19 November in UTC.
 const list=await f.admin.get('/api/tours').expect(200);
 assert.equal(list.body.length,280);assert.equal(list.headers['x-total-count'],'280');
 assert.ok(list.body.every(t=>t.departure>='2026-11-20'));assert.equal(list.body.filter(t=>t.arrival==='2026-11-20').length,40);
 const old=await f.admin.get('/api/tours').query({arrival:'2026-10-21'}).expect(200);
 assert.equal(old.body.length,40);assert.ok(old.body.some(t=>t.tour_id==='26/1'));
 assert.deepEqual((await f.admin.get('/api/tours').query({q:'26/1'})).body.map(t=>t.tour_id).slice(0,2),['26/1','26/10']);
 const capped=await f.admin.get('/api/tours').query({q:'bulk office'}).expect(200);
 assert.equal(capped.body.length,1000);assert.equal(capped.headers['x-total-count'],'1400');
 }finally{f.close();}
});
