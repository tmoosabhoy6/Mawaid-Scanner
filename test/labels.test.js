import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLabels,makeSafariLabels } from '../src/labels.js';
import { safariDates } from '../src/label-layout.js';
import { writeFileSync,mkdirSync } from 'node:fs';
const sample={token:'A'.repeat(43),tour_id:'26/1234',office:'A long office name for a narrow label layout',person_no:10000,arrival:'2026-10-21',departure:'2026-11-21',printed_at:'2026-10-21T04:00:00Z'};
for(const [name,widthMm,heightMm] of [['min',40,80],['compact-min',70,50.8],['actual',76.2,50.8],['max',104,200]])test(`label layout ${widthMm} × ${heightMm} mm`,async()=>{
 const pdf=await makeLabels([sample],{widthMm,heightMm});assert.ok(pdf.length>1000);
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/boundary-${name}.pdf`,pdf);}
});
test('calligraphy is embedded once per PDF and vector QR labels stay small',async()=>{
 const cards=Array.from({length:100},(_,n)=>({...sample,token:String(n).padStart(43,'B'),person_no:n+1}));
 const pdf=await makeLabels(cards,{widthMm:76.2,heightMm:50.8});const text=pdf.toString('latin1');
 assert.equal(text.match(/\/Subtype \/Form/g).length,1);assert.equal(text.match(/\/Type \/Page\b/g).length,100);
 // The Cloudflare upload limit is 1.5 MB for a 100-label job; vector labels use a small fraction of it.
 assert.ok(pdf.length<400000,`100 labels used ${pdf.length} bytes`);
});
const safari={office:'Izan Caravan',arrival:'2026-10-21',departure:'2026-10-24',pax:12};
for(const [name,widthMm,heightMm] of [['min',40,80],['compact-min',70,50.8],['actual',76.2,50.8],['max',104,200]])test(`Safari sticker ${widthMm} × ${heightMm} mm`,async()=>{
 const pdf=await makeSafariLabels([safari,{}],{widthMm,heightMm}),text=pdf.toString('latin1');
 assert.equal(text.match(/\/Type \/Page\b/g).length,2,'one page per Safari card');
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(`${process.env.LABEL_TEST_OUTPUT}/safari-${name}.pdf`,pdf);}
});
test('Safari stickers embed the logo once and show the card dates',async()=>{
 const pdf=await makeSafariLabels(Array.from({length:20},()=>safari),{widthMm:76.2,heightMm:50.8}),text=pdf.toString('latin1');
 assert.equal(text.match(/\/Subtype \/Image/g).length,2,'one logo image and its transparency mask');// Safari PDFs go straight to the printer and are never uploaded; vector artwork keeps each page small.
 assert.ok(pdf.length<20*20000,`20 stickers used ${pdf.length} bytes`);
 assert.equal(safariDates('2026-10-21','2026-10-24'),'21 Oct – 24 Oct 2026');assert.equal(safariDates('2026-12-30','2027-01-02'),'30 Dec 2026 – 2 Jan 2027');
 assert.equal(safariDates('2026-10-21',null),'from 21 Oct 2026');assert.equal(safariDates(null,'2026-10-24'),'until 24 Oct 2026');assert.equal(safariDates(null,null),'');
});
