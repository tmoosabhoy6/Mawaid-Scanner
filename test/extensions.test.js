import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fixture,tour,issue,scan } from './helpers.js';

// Karbala is UTC+3: 04:00Z is breakfast, 09:00Z lunch, 16:30Z dinner, 02:30Z half an hour before breakfast.
test('extend stay: lunch only or a whole day after departure, on the same cards, with history',async()=>{
 const f=await fixture();try{
 const t=await tour(f,2),{cards}=await issue(f,t.id),extend=body=>f.admin.post(`/api/tours/${t.id}/extensions`).send(body);
 assert.equal((await extend({date:'2026-10-23',meals:'lunch'})).status,400,'departure day is already included');
 assert.equal((await extend({date:'2026-10-24',meals:'dinner'})).status,400);
 assert.equal((await f.scanner.post(`/api/tours/${t.id}/extensions`).send({date:'2026-10-24',meals:'day'})).status,401);
 f.setTime('2026-10-24T04:00:00Z');
 const ended=await scan(f,cards[0].token);assert.equal(ended.body.reason,'after_departure');assert.match(ended.body.message,/extend/);
 const lunch=await extend({date:'2026-10-24',meals:'lunch'}).expect(201);
 assert.equal((await extend({date:'2026-10-24',meals:'lunch'})).body.existing,true);
 assert.equal((await scan(f,cards[0].token)).body.reason,'extension_other_meal');
 f.setTime('2026-10-24T09:00:00Z');assert.equal((await scan(f,cards[0].token)).body.status,'green');
 f.setTime('2026-10-24T16:30:00Z');assert.equal((await scan(f,cards[0].token)).body.reason,'extension_other_meal');
 // Upgrading to the whole day keeps the lunch-only row as history.
 await extend({date:'2026-10-24',meals:'day'}).expect(201);
 assert.equal((await scan(f,cards[1].token)).body.status,'green');
 const history=(await f.admin.get(`/api/tours/${t.id}/extensions`).expect(200)).body;
 assert.deepEqual(history.map(x=>[x.meals,!!x.removed_at]),[['day',false],['lunch',true]]);assert.equal(history[1].id,lunch.body.id);
 const listed=(await f.admin.get('/api/tours').expect(200)).body.find(x=>x.id===t.id);assert.equal(listed.extensions,'2026-10-24 day');
 // The tour report shows the extended tour with its meals against PAX.
 const report=(await f.admin.get('/api/summary/tours?date=2026-10-24').expect(200)).body;
 assert.deepEqual(report.map(r=>[r.tour_id,r.pax,r.extension,r.breakfast,r.lunch,r.dinner]),[['26/3205',2,'day',0,1,1]]);
 // Removing it closes the extra day again; the history keeps it.
 await f.admin.post(`/api/extensions/${history[0].id}/remove`).send({}).expect(200);
 await f.admin.post(`/api/extensions/${history[0].id}/remove`).send({}).expect(404);
 f.setTime('2026-10-24T16:45:00Z');assert.equal((await scan(f,cards[0].token)).body.reason,'after_departure');
 const archived=(await f.admin.get('/api/archive/extensions?before=2026-10-24').expect(200)).body.rows;assert.equal(archived.length,2);assert.ok(archived.every(x=>x.removed_at));
 }finally{f.close();}
});

test('duplicate scans report when the meal was first served',async()=>{
 const f=await fixture();try{
 const t=await tour(f,1),{cards}=await issue(f,t.id);
 const first=await scan(f,cards[0].token);f.setTime('2026-10-21T04:20:00Z');
 const again=await scan(f,cards[0].token);
 assert.equal(again.body.reason,'already_scanned');assert.equal(again.body.firstScannedAt,first.body.scanned_at);assert.equal(again.body.status,'red');
 }finally{f.close();}
});

test('offline scans are checked at the time they were made; a phone that showed red records no meal',async()=>{
 const f=await fixture();try{
 const t=await tour(f,3),{cards}=await issue(f,t.id);f.setTime('2026-10-21T09:00:00Z');
 const sync=(token,offlineAt,offlineStatus='green',requestKey=randomUUID())=>f.scanner.post('/api/scan').send({code:`MW1:${token}`,requestKey,offlineAt,offlineStatus});
 const key=randomUUID(),sent=await sync(cards[0].token,'2026-10-21T04:10:00Z','green',key);
 assert.deepEqual([sent.body.reason,sent.body.meal,sent.body.offline,sent.body.scanned_at],['admitted','breakfast',1,'2026-10-21T04:10:00.000Z']);
 assert.equal((await sync(cards[0].token,'2026-10-21T04:10:00Z','green',key)).body.replayed,true);
 // Two offline phones admitted the same person: the second is logged as a duplicate.
 assert.equal((await sync(cards[0].token,'2026-10-21T04:12:00Z')).body.reason,'already_scanned');
 assert.equal((await sync(cards[1].token,'2026-10-21T04:15:00Z','red')).body.reason,'offline_declined');
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM admissions WHERE meal='breakfast'").get().n,1);
 assert.equal((await sync(cards[2].token,'2026-10-18T04:15:00Z')).status,400);
 assert.equal((await sync(cards[2].token,'not a time')).status,400);
 assert.equal((await scan(f,cards[1].token)).body.meal,'lunch');
 assert.equal((await f.admin.get('/api/summary?date=2026-10-21')).body.breakfast,1);
 }finally{f.close();}
});

test('gate phones download current cards once, then only what changed',async()=>{
 const f=await fixture();try{
 const t=await tour(f,2),{cards}=await issue(f,t.id),hex=v=>createHash('sha256').update(v).digest('hex');
 const full=(await f.scanner.get('/api/scanner/data').expect(200)).body;
 assert.equal(full.full,true);assert.equal(full.hash,'hex');assert.equal(full.meal,'breakfast');
 assert.deepEqual(full.cards.map(c=>c[0]).sort(),cards.map(c=>hex(c.token)).sort());
 assert.deepEqual(full.tours,[[t.id,'2026-10-21','2026-10-23',2,1]]);assert.ok(!JSON.stringify(full).includes('FH Kuwait'),'no office names');
 await scan(f,cards[0].token);
 const replaced=await f.admin.post('/api/labels').send({personIds:[cards[0].person_id],expectedCardIds:{[cards[0].person_id]:cards[0].id},requestKey:randomUUID()}).expect(201);
 const next=f.rendered.at(-1)[0];
 const poll=(await f.scanner.get(`/api/scanner/data?cards=${full.cardCursor}&admissions=${full.admissionCursor}&date=${full.date}`).expect(200)).body;
 assert.equal(poll.full,false);assert.equal(poll.tours,undefined);
 assert.deepEqual(poll.cards,[[hex(next.token),cards[0].person_id,t.id,1,0]]);assert.ok(replaced.body.id);
 assert.deepEqual(poll.admissions,[[cards[0].person_id,'breakfast']]);
 const quiet=(await f.scanner.get(`/api/scanner/data?cards=${poll.cardCursor}&admissions=${poll.admissionCursor}&date=${poll.date}&tours=1`).expect(200)).body;
 assert.deepEqual([quiet.cards,quiet.admissions,quiet.tours.length],[[],[],1]);
 // A new day restarts the meal list.
 f.setTime('2026-10-22T04:00:00Z');
 const tomorrow=(await f.scanner.get(`/api/scanner/data?cards=${poll.cardCursor}&admissions=${poll.admissionCursor}&date=${poll.date}`).expect(200)).body;
 assert.equal(tomorrow.date,'2026-10-22');assert.deepEqual(tomorrow.admissions,[]);
 }finally{f.close();}
});

test('tour report shows each meal against PAX',async()=>{
 const f=await fixture();try{
 const t=await tour(f,3),{cards}=await issue(f,t.id);
 await scan(f,cards[0].token);await scan(f,cards[1].token);f.setTime('2026-10-21T09:00:00Z');await scan(f,cards[2].token);
 const report=(await f.admin.get('/api/summary/tours?date=2026-10-21').expect(200)).body;
 assert.deepEqual(report.map(r=>[r.tour_id,r.pax,r.breakfast,r.lunch,r.dinner,r.extension]),[['26/3205',3,2,1,0,null]]);
 }finally{f.close();}
});
