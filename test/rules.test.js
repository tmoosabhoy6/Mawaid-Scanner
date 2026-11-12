import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibility,localTime,serviceAt,validateTour,validateSafari } from '../src/rules.js';
const day='2026-10-21';
const at=(h,m,s=0)=>new Date(Date.UTC(2026,9,21,h-3,m,s));
const card={arrival:day,departure:day};
test('every Karbala time belongs to a meal: breakfast before 12:15, lunch before 18:30, then dinner',()=>{
 for(const [h,m,s,meal] of [[3,0,0,'breakfast'],[6,0,0,'breakfast'],[8,30,0,'breakfast'],[10,59,59,'breakfast'],[12,14,59,'breakfast'],[12,15,0,'lunch'],[15,0,0,'lunch'],[18,29,59,'lunch'],[18,30,0,'dinner'],[19,22,0,'dinner'],[20,30,0,'dinner'],[23,59,59,'dinner']]) {
   assert.equal(eligibility(card,at(h,m,s)).allowed,true);assert.equal(serviceAt(at(h,m,s)).meal,meal);
 }
});
test('arrival/departure inclusive; before and after always red',()=>{
 assert.equal(eligibility(card,at(7,0)).allowed,true);
 assert.equal(eligibility({...card,arrival:'2026-10-22'},at(7,0)).reason,'before_arrival');
 assert.equal(eligibility({...card,departure:'2026-10-20'},at(7,0)).reason,'after_departure');
 assert.equal(eligibility({...card,revoked_at:'now'},at(7,0)).reason,'replaced_card');
 assert.equal(eligibility(null,at(7,0)).reason,'unknown_card');
});
test('Baghdad midnight differs from the UTC date',()=>{
 assert.equal(localTime(new Date('2026-10-20T21:00:00Z')).date,day);
 assert.equal(eligibility(card,new Date('2026-10-20T20:59:59Z')).reason,'before_arrival');
 assert.equal(eligibility(card,new Date('2026-10-21T20:59:59Z')).meal,'dinner');
 assert.equal(eligibility(card,new Date('2026-10-21T21:00:00Z')).reason,'after_departure');
});
test('reject impossible dates, reverse ranges, fractional/negative/excessive PAX',()=>{
 const input={tour_id:'26/1',office:'Test',arrival:day,departure:day,pax:50};assert.equal(validateTour(input).pax,50);
 for(const patch of [{arrival:'2026-02-30'},{departure:'2026-10-20'},{pax:0},{pax:1.5},{pax:10001},{office:''},{tour_id:''},{its:'1'.repeat(41)}])assert.throws(()=>validateTour({...input,...patch}));
});
test('tours added by hand need the full tour ID; the office may be left for the server to fill in; ITS is optional',()=>{
 const input={office:'Test',arrival:day,departure:day,pax:5};
 assert.throws(()=>validateTour(input),/Enter a tour ID/);
 for(const tour_id of ['','  ','5253','2026/5253','26/','26/5253a','a26/5253','26/1234567'])assert.throws(()=>validateTour({...input,tour_id},{manual:true}),String(tour_id));
 assert.deepEqual(validateTour({...input,tour_id:' 26 / 5253 ',its:''},{manual:true}),{tour_id:'26/5253',its:null,office:'Test',arrival:day,departure:day,pax:5});
 assert.equal(validateTour({...input,tour_id:'26/5253',office:''},{manual:true}).office,'');
 assert.equal(validateTour({...input,tour_id:'26/5253',its:' 30412345 '},{manual:true}).its,'30412345');
 // The Sheet sync keeps its own IDs as they are, and still needs an office.
 assert.equal(validateTour({...input,tour_id:'2849'}).tour_id,'2849');assert.throws(()=>validateTour({...input,tour_id:'26/1',office:''}));
});
test('Safari: every field is optional; filled fields are still validated',()=>{
 assert.deepEqual(validateSafari({}),{office:null,tour_id:null,its:null,arrival:null,departure:null,pax:null});
 assert.deepEqual(validateSafari({office:' Izan Caravan ',arrival:day,departure:'2026-10-24',pax:'12'}),{office:'Izan Caravan',tour_id:null,its:null,arrival:day,departure:'2026-10-24',pax:12});
 for(const bad of [{arrival:'2026-02-30'},{arrival:'2026-10-24',departure:day},{pax:0},{pax:'2.5'},{office:'x'.repeat(161)}])assert.throws(()=>validateSafari(bad));
});
