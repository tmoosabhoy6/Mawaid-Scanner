import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture,tour,issue,scan,config } from './helpers.js';
import { writeFileSync,mkdirSync,readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeSafariLabels } from '../src/labels.js';

test('50 unique cards; one admission per meal across concurrent scans',async()=>{
 const f=await fixture();try{
 const t=await tour(f,50),{batch,cards}=await issue(f,t.id);
 assert.equal(cards.length,50);assert.equal(new Set(cards.map(c=>c.token)).size,50);
 assert.ok(cards.every(c=>/^[\w-]{43}$/.test(c.token)));
 const results=await Promise.all(Array.from({length:30},()=>scan(f,cards[0].token)));
 assert.equal(results.filter(r=>r.body.status==='green').length,1);
 assert.ok(results.every(r=>r.body.meal==='breakfast'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,30);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM admissions').get().n,1);
 f.setTime('2026-10-21T09:30:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 f.setTime('2026-10-21T16:30:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 f.setTime('2026-10-22T04:00:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 const pdf=await f.admin.get(`/api/batches/${batch.id}/pdf`).expect(200);
 assert.equal(pdf.headers['content-type'],'application/pdf');assert.ok(pdf.body.length>10000);
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/50-labels.pdf`,pdf.body);writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/expected.json`,JSON.stringify(cards.map(c=>`MW1:${c.token}`)));}
 }finally{f.close();}
});

test('five lost cards keep 50 people and revoke the originals',async()=>{
 const f=await fixture();try{
 const t=await tour(f,50),{cards}=await issue(f,t.id);
 await Promise.all(cards.slice(0,5).map(c=>scan(f,c.token)));
 const ids=cards.slice(0,5).map(c=>c.person_id);
 await f.admin.post('/api/labels').send({personIds:ids,expectedCardIds:Object.fromEntries(cards.slice(0,5).map(c=>[c.person_id,c.id])),requestKey:randomUUID()}).expect(201);
 const replacements=f.rendered.at(-1);assert.equal(replacements.length,5);
 for(const c of cards.slice(0,5))assert.equal((await scan(f,c.token)).body.reason,'replaced_card');
 for(const c of replacements)assert.equal((await scan(f,c.token)).body.reason,'already_scanned');
 await Promise.all(cards.slice(5).map(c=>scan(f,c.token)));
 const summary=await f.admin.get('/api/summary?date=2026-10-21').expect(200);assert.equal(summary.body.breakfast,50);assert.equal(summary.body.scans,50);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,50);
 }finally{f.close();}
});

test('unlimited replacement iterations; unused entitlement works on newest code only',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);let previous=cards[0];
 for(let n=0;n<12;n++){
 await f.admin.post('/api/labels').send({personIds:[previous.person_id],expectedCardIds:{[previous.person_id]:previous.id},requestKey:randomUUID()}).expect(201);
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
 // The losing operator sees either a conflict or "already has cards", depending on interleaving.
 assert.equal(results.filter(r=>r.status===201).length,1);assert.ok(results.some(r=>r.status===409||r.status===400));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM people').get().n,1);
 const person=f.db.prepare('SELECT p.id,c.id AS card_id FROM people p JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL').get();
 const replacements=await Promise.all(Array.from({length:2},()=>f.admin.post('/api/labels').send({personIds:[person.id],expectedCardIds:{[person.id]:person.card_id},requestKey:randomUUID()})));
 assert.deepEqual(replacements.map(r=>r.status).sort(),[201,409]);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE revoked_at IS NULL').get().n,1);
 }finally{f.close();}
});

test('before arrival, after departure and unknown QR deny access; scans at any hour count for that meal',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);
 for(const [clock,reason] of [['2026-10-20T04:00:00Z','before_arrival'],['2026-10-24T04:00:00Z','after_departure']]){
 f.setTime(clock);const r=await scan(f,cards[0].token);assert.equal(r.body.status,'red');assert.equal(r.body.reason,reason);
 }
 for(const [clock,meal] of [['2026-10-21T02:00:00Z','breakfast'],['2026-10-21T12:00:00Z','lunch'],['2026-10-21T16:22:00Z','dinner'],['2026-10-23T07:59:00Z','breakfast']]){f.setTime(clock);const r=await scan(f,cards[0].token);assert.equal(r.body.status,'green');assert.equal(r.body.meal,meal);}
 // Lunch runs until dinner starts, so a late lunch is a duplicate of the earlier one.
 f.setTime('2026-10-21T15:59:59Z');assert.equal((await scan(f,cards[0].token)).body.reason,'already_scanned');
 f.setTime('2026-10-23T20:59:00Z');const service=await f.scanner.get('/api/service').expect(200);assert.equal(service.body.date,'2026-10-23');assert.equal(service.body.meal,'dinner');
 assert.equal((await scan(f,'unknown')).body.reason,'unknown_card');
 }finally{f.close();}
});

test('roles, CSRF, login, validation, duplicate stays and printing setup',async()=>{
 const f=await fixture();try{
 await request(f.app).get('/api/tours').expect(401);await f.scanner.get('/api/tours').expect(401);await f.scanner.get('/api/settings').expect(401);
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
 await f.scanner.post('/api/sync/request').send({}).expect(401);await f.admin.post('/api/sync/request').send({}).expect(200);
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
 for(const time of ['2026-10-24T04:00:00Z','2026-10-24T09:30:00Z','2026-10-24T16:30:00Z']){
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

test('archive export pages records; clearing never touches today, active stays or other roles',async()=>{
 const f=await fixture();try{
 const t=await tour(f,2),{batch,cards}=await issue(f,t.id);
 assert.equal((await scan(f,cards[0].token)).body.status,'green');assert.equal((await scan(f,cards[1].token)).body.status,'green');
 f.setTime('2026-10-22T04:00:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 let status=(await f.admin.get('/api/archive?before=2026-10-22').expect(200)).body;
 assert.deepEqual(status.counts,{scans:2,meals:2,pdfs:0});assert.equal(status.today,'2026-10-22');assert.ok(status.databaseBytes>0);
 await f.admin.get('/api/archive?before=2026-10-23').expect(400);
 await f.scanner.get('/api/archive').expect(401);await f.scanner.post('/api/archive/clear').send({before:'2026-10-22'}).expect(401);
 await f.admin.post('/api/archive/clear').send({}).expect(400);await f.admin.post('/api/archive/clear').send({before:''}).expect(400);await f.admin.get('/api/archive/unknown').expect(404);
 const first=(await f.admin.get('/api/archive/scans?before=2026-10-22&limit=1').expect(200)).body;
 assert.equal(first.rows.length,1);assert.equal(first.rows[0].tour_id,'26/3205');assert.equal(first.rows[0].reason,'admitted');assert.ok(first.next);
 const rest=(await f.admin.get(`/api/archive/scans?before=2026-10-22&limit=1&after=${first.next}`).expect(200)).body;
 assert.equal(rest.rows.length,1);assert.notEqual(rest.rows[0].cursor,first.rows[0].cursor);
 const meals=(await f.admin.get('/api/archive/meals?before=2026-10-22').expect(200)).body;assert.equal(meals.rows.length,2);assert.equal(meals.next,null);assert.equal(meals.rows[0].meal,'breakfast');
 for(const name of ['tours','cards','prints'])assert.ok((await f.admin.get(`/api/archive/${name}?before=2026-10-22`).expect(200)).body.rows.length>=1);
 const cleared=(await f.admin.post('/api/archive/clear').send({before:'2026-10-22'}).expect(200)).body;
 assert.deepEqual(cleared.deleted,{scans:2,meals:2,pdfs:0});assert.equal(cleared.done,true);
 // Today's scan record survives.
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,1);
 await f.admin.get(`/api/batches/${batch.id}/pdf`).expect(200);
 f.setTime('2026-10-25T04:00:00Z');
 const later=(await f.admin.post('/api/archive/clear').send({before:'2026-10-25'}).expect(200)).body;assert.equal(later.deleted.pdfs,1);
 const gone=await f.admin.get(`/api/batches/${batch.id}/pdf`).expect(410);assert.match(gone.body.error,/cleared/);
 const log=(await f.admin.get('/api/batches').expect(200)).body[0];assert.equal(log.printer_status,'pdf_cleared');assert.equal(log.pdf_ready,0);
 assert.equal((await f.admin.get('/api/tours').expect(200)).body[0].batch_status,'pdf_cleared');
 await f.admin.post(`/api/batches/${batch.id}/status`).send({status:'printer_error'}).expect(200);
 assert.equal((await f.admin.get('/api/batches').expect(200)).body[0].printer_status,'pdf_cleared');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cards').get().n,2);
 }finally{f.close();}
});

test('tour ID and ITS are optional; tours without an ID never merge and still print QR cards',async()=>{
 const f=await fixture();try{
 const base={office:'Walk-in group',arrival:'2026-10-21',departure:'2026-10-23',pax:1};
 const a=await f.admin.post('/api/tours').send({...base,tour_id:'',its:'30412345'}).expect(201),b=await f.admin.post('/api/tours').send(base).expect(201);
 assert.notEqual(a.body.id,b.body.id);assert.equal(a.body.tour_id,null);assert.equal(a.body.its,'30412345');assert.equal(b.body.existing,undefined);
 const found=(await f.admin.get('/api/tours').query({q:'304123'}).expect(200)).body;assert.equal(found.length,1);assert.equal(found[0].its,'30412345');
 const {cards}=await issue(f,a.body.id);assert.equal(cards[0].tour_id,null);assert.equal((await scan(f,cards[0].token)).body.status,'green');
 const logs=(await f.admin.get('/api/logs').expect(200)).body;assert.equal(logs[0].display_tour,null);
 assert.equal((await f.admin.get('/api/summary?date=2026-10-21').expect(200)).body.scans,1);
 // A tour ID entered again for the same arrival still finds the existing stay.
 const named=await tour(f,1);assert.equal((await f.admin.post('/api/tours').send({...named,its:'1'}).expect(200)).body.id,named.id);
 // Typing the tour ID without the Sheet's year prefix, for an overlapping stay, finds the same tour.
 const sheet=(await f.admin.post('/api/tours').send({...base,tour_id:'26/2849',arrival:'2026-10-21',departure:'2026-10-24',pax:3}).expect(201)).body;
 const again=(await f.admin.post('/api/tours').send({...base,tour_id:'2849',arrival:'2026-10-24',departure:'2026-10-24',pax:2}).expect(200)).body;
 assert.equal(again.id,sheet.id);assert.equal(again.pax,3);assert.equal(again.issued,0);
 await f.admin.post('/api/tours').send({...base,tour_id:'2849',arrival:'2026-10-26',departure:'2026-10-27'}).expect(201);
 }finally{f.close();}
});

test('Safari cards: every field optional, admin only, listed by arrival and search, never QR cards',async()=>{
 const f=await fixture();try{
 const blank=await f.admin.post('/api/safaris').send({}).expect(201);assert.equal(blank.body.office,null);assert.equal(blank.body.pax,null);
 const izan=await f.admin.post('/api/safaris').send({office:'Izan Caravan',arrival:'2026-10-21',departure:'2026-10-24',pax:'12',its:'',tour_id:''}).expect(201);
 assert.equal(izan.body.pax,12);assert.equal(izan.body.its,null);
 await f.admin.post('/api/safaris').send({arrival:'2026-10-24',departure:'2026-10-21'}).expect(400);
 await f.admin.post('/api/safaris').send({pax:0}).expect(400);
 await f.scanner.get('/api/safaris').expect(401);await f.scanner.post('/api/safaris').send({}).expect(401);
 const all=(await f.admin.get('/api/safaris').expect(200)).body;assert.deepEqual(all.map(s=>s.id),[izan.body.id,blank.body.id]);
 assert.deepEqual((await f.admin.get('/api/safaris').query({arrival:'2026-10-21'}).expect(200)).body.map(s=>s.id),[izan.body.id]);
 assert.deepEqual((await f.admin.get('/api/safaris').query({q:'izan'}).expect(200)).body.map(s=>s.id),[izan.body.id]);
 assert.deepEqual((await f.admin.get('/api/tours').expect(200)).body,[]);
 await f.admin.post('/api/labels').send({tourIds:[izan.body.id],requestKey:randomUUID()}).expect(404);
 }finally{f.close();}
});

test('tours list keeps finished stays; Show and Sort by apply to tours and Safari cards',async()=>{
 const f=await fixture();try{
 const done=await tour(f,1,{tour_id:'26/9',arrival:'2026-10-21',departure:'2026-10-22'});
 await tour(f,2,{tour_id:'26/10',arrival:'2026-10-25',departure:'2026-10-27'});await tour(f,1,{tour_id:'26/100',arrival:'2026-11-02',departure:'2026-11-04'});
 await issue(f,done.id);f.setTime('2026-11-03T04:00:00Z');
 const tours=async query=>(await f.admin.get('/api/tours').query(query).expect(200)).body.map(t=>t.tour_id);
 assert.deepEqual(await tours({}),['26/100','26/10','26/9'],'newest arrival first, finished stay still listed');
 assert.deepEqual(await tours({sort:'oldest'}),['26/9','26/10','26/100']);
 assert.deepEqual(await tours({status:'printed'}),['26/9']);assert.deepEqual(await tours({status:'unprinted',sort:'oldest'}),['26/10','26/100']);
 assert.deepEqual(await tours({status:'unprinted',q:'26/10'}),['26/100','26/10']);assert.deepEqual(await tours({status:'printed',arrival:'2026-10-25'}),[]);
 assert.deepEqual(await tours({sort:"x'; DROP TABLE tours; --",status:'other'}),['26/100','26/10','26/9'],'unknown choices fall back to the defaults');
 const safari=async body=>(await f.admin.post('/api/safaris').send(body).expect(201)).body;
 const a=await safari({office:'A',arrival:'2026-10-21',departure:'2026-10-24'});await safari({office:'B',arrival:'2026-10-30',departure:'2026-11-01'});await safari({office:'C'});
 const pdf=await makeSafariLabels([a],{widthMm:76.2,heightMm:50.8});
 await f.admin.post(`/api/safaris/print?requestKey=${randomUUID()}&ids=${a.id}`).set('Content-Type','application/pdf').send(pdf).expect(201);
 const safaris=async query=>(await f.admin.get('/api/safaris').query(query).expect(200)).body.map(s=>s.office);
 assert.deepEqual(await safaris({}),['B','A','C'],'undated Safari cards come last');assert.deepEqual(await safaris({sort:'oldest'}),['A','B','C']);
 assert.deepEqual(await safaris({status:'printed'}),['A']);assert.deepEqual(await safaris({status:'unprinted'}),['B','C']);
 }finally{f.close();}
});
