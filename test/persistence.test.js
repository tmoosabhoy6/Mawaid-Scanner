import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { makeLabels } from '../src/labels.js';
import { config } from './helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';

test('server restart preserves cards, PDFs, sessions and scan history',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mawayid-persist-'));let app;let captured;
 try{
 const options={...config,dataDir,now:()=>new Date('2026-10-21T04:00:00Z'),renderLabels:async(c,s)=>{captured=c;return makeLabels(c,s);}};
 app=createApp(options);let agent=request.agent(app);
 await agent.post('/api/login').send({password:config.adminPassword}).expect(200);
 await agent.post('/api/settings').send({printer:{widthMm:76.2,heightMm:50.8,name:'Test'}}).expect(200);
 const tour=await agent.post('/api/tours').send({tour_id:'26/1',office:'Test',arrival:'2026-10-21',departure:'2026-10-22',pax:1}).expect(201);
 const batch=await agent.post('/api/labels').send({tourIds:[tour.body.id],requestKey:randomUUID()}).expect(201);
 const code=`MW1:${captured[0].token}`;
 assert.equal((await agent.post('/api/scan').send({code,requestKey:randomUUID()})).body.status,'green');
 app.locals.db.close();app=createApp(options);agent=request.agent(app);
 await agent.post('/api/login').send({password:config.adminPassword}).expect(200);
 const again=await agent.post('/api/scan').send({code,requestKey:randomUUID()}).expect(200);assert.equal(again.body.reason,'breakfast_repeat');assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM scan_logs').get().n,2);
 const pdf=await agent.get(`/api/batches/${batch.body.id}/pdf`).expect(200);assert.ok(pdf.body.length>1000);
 assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,2);
 }finally{if(app)app.locals.db.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('a database from before optional tour IDs is upgraded in place, keeping every row',()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mawayid-upgrade-')),path=join(dataDir,'mawayid.sqlite');
 try{
 const old=new DatabaseSync(path);
 old.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE tours (id TEXT PRIMARY KEY, tour_id TEXT NOT NULL, office TEXT NOT NULL, arrival TEXT NOT NULL, departure TEXT NOT NULL, pax INTEGER NOT NULL CHECK(pax>0),
   source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(tour_id,arrival), CHECK(arrival<=departure));
  CREATE TABLE people (id TEXT PRIMARY KEY, tour_id TEXT NOT NULL REFERENCES tours(id), person_no INTEGER NOT NULL, UNIQUE(tour_id,person_no));
  INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t1','26/1','A','2026-10-21','2026-10-22',1,'x'),('t2','26/2','B','2026-10-21','2026-10-22',1,'x');
  INSERT INTO people VALUES('p1','t2',1);`);
 old.close();
 const db=openDatabase(path);
 assert.deepEqual(db.prepare('SELECT rowid,id,tour_id,its FROM tours ORDER BY rowid').all().map(r=>({...r})),[{rowid:1,id:'t1',tour_id:'26/1',its:null},{rowid:2,id:'t2',tour_id:'26/2',its:null}]);
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,created_at) VALUES('t3',NULL,'C','2026-10-21','2026-10-22',1,'x'),('t4',NULL,'D','2026-10-21','2026-10-22',1,'x')").run();
 assert.throws(()=>db.prepare("INSERT INTO people VALUES('p9','missing',1)").run(),/FOREIGN KEY/);
 db.close();openDatabase(path).close();
 }finally{rmSync(dataDir,{recursive:true,force:true});}
});
