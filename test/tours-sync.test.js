import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('apps-script/ToursSync.js','utf8');const context={};vm.createContext(context);vm.runInContext(source,context);
const parse=data=>JSON.parse(JSON.stringify(context.MAWAYID_buildTours(data,context.MAWAYID_CONFIG)));
function row({arrival,departure,id='26/1',pax=5,office='Test'}){const r=Array(20).fill('');if(arrival){r[1]=id;r[2]=office;r[4]=pax;}if(departure){r[16]=id;r[17]=office;r[19]=pax;}return r;}
const headers=()=>{const h=Array(20).fill('');h[1]='Pehli Ziyarat';h[16]='Wada Ziyarat';return h;};
const day=date=>[date];
test('merged source columns, active stays across cutoff, same-day stays, repeated visits',()=>{
 const result=parse([headers(),day('Tuesday, October 20, 2026'),row({arrival:true}),day('Wednesday, October 21, 2026'),row({departure:true}),row({arrival:true,departure:true,id:'26/2'}),day('Friday, October 23, 2026'),row({arrival:true}),day('Saturday, October 24, 2026'),row({departure:true})]);
 assert.equal(result.tours.length,3);assert.equal(result.tours[0].arrival,'2026-10-20');assert.equal(result.tours[0].departure,'2026-10-22');assert.equal(result.tours[1].departure,'2026-10-22');assert.equal(result.tours[2].departure,'2026-10-25');assert.equal(result.warnings.length,0);
});
test('missing or ambiguous departures and mismatched PAX excluded; invalid source aborts',()=>{
 const result=parse([headers(),day('Wednesday, October 21, 2026'),row({arrival:true}),row({arrival:true,id:'26/2'}),day('Thursday, October 22, 2026'),row({departure:true,id:'26/2',pax:6})]);
 assert.equal(result.tours.length,0);assert.equal(result.warnings.length,2);
 assert.throws(()=>parse([headers(),day('Wednesday, October 21, 2026'),row({arrival:true,pax:'bad'})]),/PAX/);
 assert.throws(()=>parse([day('Wednesday, October 21, 2026'),row({arrival:true})]),/headers/);
});
test('duplicates coalesce; conflicting duplicates abort; old stays omitted',()=>{
 const arrival=row({arrival:true});
 assert.equal(parse([headers(),day('Sunday, October 18, 2026'),arrival,arrival,day('Monday, October 19, 2026'),row({departure:true})]).tours.length,0);
 assert.throws(()=>parse([headers(),day('Wednesday, October 21, 2026'),arrival,row({arrival:true,pax:10})]),/Conflicting/);
});
test('calendar parser rejects impossible dates and source globals are isolated',()=>{
 assert.equal(context.MAWAYID_date('Wednesday, February 30, 2026'),null);
 assert.equal(context.MAWAYID_date('Wednesday, October 21, 2026'),'2026-10-21');
 const names=[...source.matchAll(/^function\s+(\w+)/gm)].map(m=>m[1]);assert.ok(names.every(name=>name.startsWith('MAWAYID_')));
 assert.equal(source.includes('deleteTrigger('),false);assert.equal(source.includes('function doGet'),false);assert.equal(source.includes('function flattenZiyaratSchedule'),false);
});

test('setup creates only the separate tours trigger and leaves flatten trigger intact',()=>{
 for(const hasOwnTrigger of [false,true]){
 const calls=[];
 const sandbox={ScriptApp:{getProjectTriggers:()=>[ {getHandlerFunction:()=> 'flattenZiyaratSchedule'},...(hasOwnTrigger?[{getHandlerFunction:()=> 'MAWAYID_refreshTours'}]:[])],newTrigger:name=>{calls.push(name);return {timeBased(){return this;},everyMinutes(n){calls.push(n);return this;},create(){calls.push('created');}};}}};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);sandbox.MAWAYID_refreshTours=force=>calls.push(['refresh',force]);sandbox.MAWAYID_setupTours();
 assert.deepEqual(calls,hasOwnTrigger?[['refresh',true]]:[['refresh',true],'MAWAYID_refreshTours',5,'created']);
 }
});


test('Wada plus one day includes launch-day departures and calendar rollovers',()=>{
 const result=parse([headers(),day('Monday, October 19, 2026'),row({arrival:true}),day('Tuesday, October 20, 2026'),row({departure:true})]);
 assert.equal(result.tours.length,1);assert.equal(result.tours[0].departure,'2026-10-21');
 for(const [wada,departure] of [['2026-10-31','2026-11-01'],['2026-12-31','2027-01-01'],['2028-02-28','2028-02-29'],['2028-02-29','2028-03-01']])assert.equal(context.MAWAYID_nextDay(wada),departure);
});

test('shifted departure cannot overlap another arrival for the same tour',()=>{
 const result=parse([headers(),day('Tuesday, October 20, 2026'),row({arrival:true,departure:true}),day('Wednesday, October 21, 2026'),row({arrival:true}),day('Thursday, October 22, 2026'),row({departure:true})]);
 assert.equal(result.tours.length,1);assert.equal(result.tours[0].arrival,'2026-10-21');assert.match(result.warnings[0],/overlaps/);
});
