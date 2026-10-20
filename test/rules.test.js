import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibility,localTime,serviceAt,validateTour } from '../src/rules.js';
const day='2026-10-21';
const at=(h,m,s=0)=>new Date(Date.UTC(2026,9,21,h-3,m,s));
const card={arrival:day,departure:day};
for(const [name,start,end] of [['breakfast',[6,30],[9,0]],['lunch',[12,30],[15,0]],['dinner',[19,0],[21,30]]]){
 test(`${name}: exact opening, closing and adjacent seconds`,()=>{
  const open=at(...start),close=at(...end);
  assert.equal(serviceAt(new Date(+open-1000)).meal,null);
  assert.equal(serviceAt(open).meal.id,name);
  assert.equal(serviceAt(new Date(+close-1000)).meal.id,name);
  assert.equal(serviceAt(close).meal,null);
  assert.equal(eligibility(card,open).allowed,true);
 });
}
test('arrival/departure inclusive; before and after always red',()=>{
 assert.equal(eligibility(card,at(7,0)).allowed,true);
 assert.equal(eligibility({...card,arrival:'2026-10-22'},at(7,0)).reason,'before_arrival');
 assert.equal(eligibility({...card,departure:'2026-10-20'},at(7,0)).reason,'after_departure');
 assert.equal(eligibility({...card,revoked_at:'now'},at(7,0)).reason,'replaced_card');
 assert.equal(eligibility(null,at(7,0)).reason,'unknown_card');
});
test('Baghdad midnight differs from UTC date and launch cutoff is enforced',()=>{
 assert.equal(localTime(new Date('2026-10-20T21:00:00Z')).date,day);
 assert.equal(serviceAt(new Date('2026-10-20T04:00:00Z')).meal,null);
 assert.equal(serviceAt(at(23,59)).meal,null);
});
test('reject impossible dates, reverse ranges, fractional/negative/excessive PAX',()=>{
 const input={tour_id:'26/1',office:'Test',arrival:day,departure:day,pax:50};assert.equal(validateTour(input).pax,50);
 for(const patch of [{arrival:'2026-02-30'},{departure:'2026-10-20'},{pax:0},{pax:1.5},{pax:10001},{office:''},{tour_id:''}])assert.throws(()=>validateTour({...input,...patch}));
});
