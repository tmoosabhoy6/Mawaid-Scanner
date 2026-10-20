import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLabels } from '../src/labels.js';
import { writeFileSync,mkdirSync } from 'node:fs';
const sample={token:'A'.repeat(43),tour_id:'26/1234',office:'A long office name for a narrow label layout',person_no:10000,arrival:'2026-10-21',departure:'2026-11-21',printed_at:'2026-10-21T04:00:00Z'};
for(const [name,widthMm,heightMm] of [['min',40,80],['compact-min',70,50.8],['actual',76.2,50.8],['max',104,200]])test(`label layout ${widthMm} × ${heightMm} mm`,async()=>{
 const pdf=await makeLabels([sample],{widthMm,heightMm});assert.ok(pdf.length>1000);
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/boundary-${name}.pdf`,pdf);}
});
