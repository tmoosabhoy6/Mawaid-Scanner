import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makeLabels } from '../src/labels.js';
export const config = { adminPassword:'admin-test-password-123',syncToken:'test-sync-token-'.repeat(4),origin:'http://localhost:3000' };
export async function fixture(options = {}) {
  const db=openDatabase(':memory:'); let clock=new Date('2026-10-21T03:30:00Z'); const rendered=[];
  const app=createApp({...config,db,now:()=>clock,renderLabels:async(cards,settings)=>{rendered.push(cards);return options.renderLabels ? options.renderLabels(cards,settings) : makeLabels(cards,settings);}});
  const server=app.listen(0);server.setMaxListeners(100);
  // The scanner never signs in, so its agent carries no session.
  const admin=request.agent(server),scanner=request.agent(server);
  await admin.post('/api/login').send({role:'admin',password:config.adminPassword}).expect(200);
  await admin.post('/api/settings').send({printer:{widthMm:76.2,heightMm:50.8,name:'Zebra test'}}).expect(200);
  return {db,app,admin,scanner,rendered,setTime(value){clock=new Date(value);},close(){server.close();db.close();}};
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
