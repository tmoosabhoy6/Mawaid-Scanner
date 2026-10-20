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

test('server restart preserves cards, PDFs, sessions and consumed meals',async()=>{
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
 const duplicate=await agent.post('/api/scan').send({code,requestKey:randomUUID()}).expect(200);assert.equal(duplicate.body.reason,'already_used');
 const pdf=await agent.get(`/api/batches/${batch.body.id}/pdf`).expect(200);assert.ok(pdf.body.length>1000);
 assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,2);
 }finally{if(app)app.locals.db.close();rmSync(dataDir,{recursive:true,force:true});}
});
