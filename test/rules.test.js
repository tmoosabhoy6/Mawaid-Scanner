import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibility,localTime,serviceAt,validateTour,validateSafari } from '../src/rules.js';
const day='2026-10-21';
const at=(h,m,s=0)=>new Date(Date.UTC(2026,9,21,h-3,m,s));
const card={arrival:day,departure:day};
test('any time of day within the stay is green: there are no meal windows',()=>{
 for(const time of [at(0,0),at(5,59,59),at(9,0),at(11,0),at(15,0),at(18,30),at(21,30),at(23,59,59)])assert.equal(eligibility(card,time).allowed,true);
 assert.deepEqual(Object.keys(serviceAt(at(7,0))),['date']);
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
 assert.equal(eligibility(card,new Date('2026-10-21T20:59:59Z')).allowed,true);
 assert.equal(eligibility(card,new Date('2026-10-21T21:00:00Z')).reason,'after_departure');
});
test('reject impossible dates, reverse ranges, fractional/negative/excessive PAX',()=>{
 const input={tour_id:'26/1',office:'Test',arrival:day,departure:day,pax:50};assert.equal(validateTour(input).pax,50);
 for(const patch of [{arrival:'2026-02-30'},{departure:'2026-10-20'},{pax:0},{pax:1.5},{pax:10001},{office:''},{tour_id:''},{its:'1'.repeat(41)}])assert.throws(()=>validateTour({...input,...patch}));
});
test('tour ID and ITS are optional for tours added by hand; the sheet sync still needs a tour ID',()=>{
 const input={office:'Test',arrival:day,departure:day,pax:5};
 assert.throws(()=>validateTour(input));
 assert.deepEqual(validateTour({...input,tour_id:'  ',its:''},{requireId:false}),{tour_id:null,its:null,office:'Test',arrival:day,departure:day,pax:5});
 assert.equal(validateTour({...input,its:' 30412345 '},{requireId:false}).its,'30412345');
});
test('Safari: every field is optional; filled fields are still validated',()=>{
 assert.deepEqual(validateSafari({}),{office:null,tour_id:null,its:null,arrival:null,departure:null,pax:null});
 assert.deepEqual(validateSafari({office:' Izan Caravan ',arrival:day,departure:'2026-10-24',pax:'12'}),{office:'Izan Caravan',tour_id:null,its:null,arrival:day,departure:'2026-10-24',pax:12});
 for(const bad of [{arrival:'2026-02-30'},{arrival:'2026-10-24',departure:day},{pax:0},{pax:'2.5'},{office:'x'.repeat(161)}])assert.throws(()=>validateSafari(bad));
});
