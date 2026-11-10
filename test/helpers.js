import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makeLabels } from '../src/labels.js';
export const config = { adminPassword:'admin-test-password-123',syncToken:'test-sync-token-'.repeat(4),origin:'http://localhost:3000' };
export async function fixture(options = {}) {
  const db=openDatabase(':memory:'); let clock=new Date('2026-10-21T04:00:00Z'); const rendered=[];
  const app=createApp({...config,db,now:()=>clock,renderLabels:async(cards,settings)=>{rendered.push(cards);return options.renderLabels ? options.renderLabels(cards,settings) : makeLabels(cards,settings);}});
  const server=app.listen(0);server.setMaxListeners(100);
  // The scanner never signs in, so its agent carries no session.
  const admin=request.agent(server),scanner=request.agent(server);
  await admin.post('/api/login').send({role:'admin',password:config.adminPassword}).expect(200);
  await admin.post('/api/settings').send({printer:{widthMm:76.2,heightMm:50.8,name:'Zebra test'}}).expect(200);
  return {db,app,admin,scanner,rendered,getTime(){return clock;},setTime(value){clock=new Date(value);},close(){server.close();db.close();}};
}
export async function tour(f,pax=2,extra={}) {
  const {body}=await f.admin.post('/api/tours').send({tour_id:'26/3205',office:'FH Kuwait',pax,arrival:'2026-10-21',departure:'2026-10-23',...extra}).expect(201);
  return body;
}
export async function issue(f,id) {
  const response=await f.admin.post('/api/labels').send({tourIds:[id],requestKey:randomUUID()}).expect(201);
  return {batch:response.body,cards:f.rendered.at(-1)};
}
export function scan(f,code,key=randomUUID()){return f.scanner.post('/api/scan').send({code:`MW1:${code}`,requestKey:key});}
// Replacing cards is no longer offered, but the live database still holds cards replaced earlier.
// This recreates one: the person's current card is revoked and a newer card is added for them.
export function replaceCard(f,card){
  const stamp=f.getTime().toISOString(),batch=randomUUID(),id=randomUUID(),token=randomUUID();
  f.db.prepare("INSERT INTO batches(id,created_at,kind,request_key) VALUES(?,?,'replacement',?)").run(batch,stamp,batch);
  f.db.prepare('UPDATE cards SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL').run(stamp,card.person_id);
  f.db.prepare('INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES(?,?,?,?,?)').run(id,card.person_id,batch,createHash('sha256').update(token).digest('hex'),stamp);
  return {...card,id,token};
}
