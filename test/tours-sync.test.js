import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
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
test('historical conflicts and invalid rows do not block a later valid visit by the same tour',()=>{
 const result=parse([headers(),day('Sunday, October 26, 2025'),row({arrival:true,id:'25/4576',pax:7}),row({arrival:true,id:'25/4576',pax:9}),row({arrival:true,id:'25/4577',pax:'bad'}),
 day('Friday, October 31, 2025'),row({departure:true,id:'25/4576',pax:7}),row({departure:true,id:'25/4577',pax:'bad'}),
 day('Wednesday, October 21, 2026'),row({arrival:true,id:'25/4576',pax:4}),day('Thursday, October 22, 2026'),row({departure:true,id:'25/4576',pax:4})]);
 assert.equal(result.tours.length,1);assert.equal(result.tours[0].pax,4);assert.equal(result.tours[0].arrival,'2026-10-21');assert.equal(result.tours[0].departure,'2026-10-23');
});
test('conflicting arrivals before cutoff still block if their actual departure reaches launch',()=>{
 assert.throws(()=>parse([headers(),day('Monday, October 19, 2026'),row({arrival:true,pax:7}),row({arrival:true,pax:9}),day('Tuesday, October 20, 2026'),row({departure:true,pax:7})]),/Conflicting.*rows 3 and 4/);
 assert.throws(()=>parse([headers(),day('Monday, October 19, 2026'),row({arrival:true,pax:7}),day('Tuesday, October 20, 2026'),row({departure:true,pax:7}),row({departure:true,pax:9})]),/Conflicting/);
 assert.throws(()=>parse([headers(),day('Monday, October 19, 2026'),row({arrival:true,pax:'bad'}),day('Tuesday, October 20, 2026'),row({departure:true,pax:7})]),/Invalid office\/PAX/);
});
test('calendar parser rejects impossible dates and source globals are isolated',()=>{
 assert.equal(context.MAWAYID_date('Wednesday, February 30, 2026'),null);
 assert.equal(context.MAWAYID_date('Wednesday, October 21, 2026'),'2026-10-21');
 const names=[...source.matchAll(/^function\s+(\w+)/gm)].map(m=>m[1]);assert.ok(names.every(name=>name.startsWith('MAWAYID_')));
 assert.deepEqual([...source.matchAll(/deleteTrigger\(([^)]*)\)/g)].map(m=>m[1]),['triggers[i]']);assert.equal(source.includes('function doGet'),false);assert.equal(source.includes('function flattenZiyaratSchedule'),false);
});

test('setup installs a one-minute tours trigger, replacing only its own earlier one',()=>{
 for(const hasOwnTrigger of [false,true]){
 const calls=[],flatten={getHandlerFunction:()=> 'flattenZiyaratSchedule'},own={getHandlerFunction:()=> 'MAWAYID_refreshTours'};
 const sandbox={ScriptApp:{getProjectTriggers:()=>[flatten,...(hasOwnTrigger?[own]:[])],deleteTrigger:t=>calls.push(['deleted',t.getHandlerFunction()]),newTrigger:name=>{calls.push(name);return {timeBased(){return this;},everyMinutes(n){calls.push(n);return this;},create(){calls.push('created');}};}}};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);sandbox.MAWAYID_refreshTours=force=>calls.push(['refresh',force]);sandbox.MAWAYID_setupTours();
 assert.deepEqual(calls,[['refresh',true],...(hasOwnTrigger?[['deleted','MAWAYID_refreshTours']]:[]),'MAWAYID_refreshTours',1,'created']);
 }
});

// A stand-in for the Apps Script services, enough to run a whole sync.
function appsScript(sourceRows,{requestedAt=null}={}){
 let now=new Date('2026-10-27T09:00:00Z');const store={MAWAYID_APP_URL:'https://mawaid.test',MAWAYID_SYNC_TOKEN:'t'.repeat(32)},pushes=[],reads=[],config={spreadsheetId:'12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',tab:'Tours',dailyTimes:[],requestedAt,lastSuccess:null};
 const grid=rows=>({rows,getLastRow:()=>rows.length,getLastColumn:()=>20,getMaxRows:()=>1000,insertRowsAfter(){},setFrozenRows(){},getName:()=>rows===sourceRows?'KRB - 25':'Tours',
  getRange(r,c,nr=1,nc=1){if(rows===sourceRows)reads.push([r,nr,nc]);return {getDisplayValues:()=>Array.from({length:nr},(_,i)=>Array.from({length:nc},(_,j)=>String(rows[r-1+i]?.[c-1+j]??''))),setNumberFormat(){},clearContent(){},setValues(v){v.forEach((line,i)=>{rows[r-1+i]=line;});}};}});
 const tours=grid([]),sheets={'KRB - 25':grid(sourceRows),Tours:tours};
 const sandbox={Date:class extends Date{constructor(...a){super(...(a.length?a:[now.getTime()]));}},Logger:{log(){}},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>store[k]??null,setProperty:(k,v)=>{store[k]=v;},setProperties:o=>Object.assign(store,o)})},
  LockService:{getUserLock:()=>({tryLock:()=>true,releaseLock(){}})},
  UrlFetchApp:{fetch(url,options){if(url.endsWith('/api/sync/config'))return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(config)};pushes.push(JSON.parse(options.payload));config.lastSuccess=now.toISOString();return {getResponseCode:()=>200,getContentText:()=>'{}'};}},
  SpreadsheetApp:{openById:()=>({getId:()=>config.spreadsheetId,getSheetByName:n=>sheets[n],getSheets:()=>Object.values(sheets),insertSheet(){}}),flush(){}},
  Utilities:{DigestAlgorithm:{MD5:'md5'},computeDigest:(a,text)=>[...createHash('md5').update(text).digest()],base64Encode:bytes=>Buffer.from(bytes).toString('base64'),
   formatDate:(d,tz,f)=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));return f==='HH:mm'?`${p.hour}:${p.minute}`:`${p.year}-${p.month}-${p.day}`;}}};
 vm.createContext(sandbox);vm.runInContext(source,sandbox);
 return {run:force=>sandbox.MAWAYID_refreshTours(force),pushes,reads,tours,config,later(minutes){now=new Date(now.getTime()+minutes*60000);}};
}
test('each run reads only recent day blocks, sends a changed Sheet at once, and an unchanged one every ten minutes',()=>{
 // Last year's blocks come first and cannot reach the cutoff, so they are not read.
 const rows=[headers(),day('Friday, August 8, 2025'),row({arrival:true,id:'25/1'}),day('Wednesday, August 13, 2025'),row({departure:true,id:'25/1'}),
  [...day('Sunday, August 23, 2026')],headers(),day('Tuesday, October 20, 2026'),row({arrival:true}),day('Thursday, October 22, 2026'),row({departure:true})];
 const s=appsScript(rows);
 s.run();assert.equal(s.pushes.length,1);assert.deepEqual(JSON.parse(JSON.stringify(s.pushes[0].tours)),[{tour_id:'26/1',office:'Test',arrival:'2026-10-20',departure:'2026-10-23',pax:5}]);
 assert.deepEqual(s.reads.map(r=>r[0]),[1,6],'column A, then from the first block within 60 days of the cutoff');assert.equal(s.tours.rows[1][0],'26/1');
 s.later(1);s.run();assert.equal(s.pushes.length,1,'unchanged Sheet is not sent again');
 rows.push(row({arrival:true,id:'26/2'}),day('Friday, October 23, 2026'),row({departure:true,id:'26/2'}));
 s.later(1);s.run();assert.equal(s.pushes.length,2,'a new tour is sent on the next minute');assert.equal(s.pushes[1].tours.length,2);
 s.later(9);s.run();assert.equal(s.pushes.length,2);
 s.later(1);s.run();assert.equal(s.pushes.length,3,'resent after ten minutes so Settings stays current');
 // Request sync in the app sends on the next run.
 s.later(1);s.config.requestedAt=new Date(Date.parse(s.config.lastSuccess)+1000).toISOString();s.run();assert.equal(s.pushes.length,4);
});
test('source row numbers in errors count from where the read started',()=>{
 assert.throws(()=>context.MAWAYID_buildTours([headers(),day('Wednesday, October 21, 2026'),row({arrival:true,pax:7}),row({arrival:true,pax:9}),day('Thursday, October 22, 2026'),row({departure:true,pax:7})],context.MAWAYID_CONFIG,101),/rows 103 and 104/);
 assert.equal(context.MAWAYID_firstRow([['x'],['Friday, August 8, 2025'],[''],['Sunday, August 23, 2026']],'2026-08-22'),4);
 assert.equal(context.MAWAYID_firstRow([['no dates here']],'2026-08-22'),1);
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
