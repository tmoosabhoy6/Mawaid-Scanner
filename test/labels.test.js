import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLabels,makeSafariLabels } from '../src/labels.js';
import { drawLabels,drawSafariLabels,safariDates } from '../src/label-layout.js';
import { FAIZ_LOGO } from '../src/faiz-e-husaini-logo.js';
import { createCanvas,loadImage } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
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
// The monochrome ZD220D halftones grey or colour into scattered dots; like the QR, every sticker mark is solid black.
async function uncompressed(draw,widthMm,heightMm){
 const doc=new PDFDocument({size:[widthMm*72/25.4,heightMm*72/25.4],compress:false,autoFirstPage:false}),chunks=[];doc.on('data',c=>chunks.push(c));
 const done=new Promise(r=>doc.on('end',r));await draw(doc,{widthMm,heightMm});doc.end();await done;return Buffer.concat(chunks).toString('latin1');
}
test('meal cards and Safari stickers print only solid black, with lines at least 3 printer dots thick',async()=>{
 const kinds={'meal card':(doc,size)=>drawLabels(doc,[sample],size,(t,o)=>QRCode.create(t,o)),'Safari sticker':(doc,size)=>drawSafariLabels(doc,[{arrival:'2026-10-21',departure:'2026-10-24',pax:12},{}],size)};
 for(const [kind,draw] of Object.entries(kinds))for(const [widthMm,heightMm] of [[76.2,50.8],[104,200]]){
  const text=await uncompressed(draw,widthMm,heightMm),where=`${kind} ${widthMm} × ${heightMm} mm`,colours=[...text.matchAll(/^([\d. ]+) (scn|SCN|sc|SC|rg|RG|g|G|k|K)$/gm)];
  assert.ok(colours.length>5);
  // Black ink, or white where the pattern lines cross the black arches.
  for(const [op,values] of colours)assert.ok(/^(0 0 0|1 1 1) /.test(op),`${where}: ${op}`);
  for(const [,width] of text.matchAll(/^([\d.]+) w$/gm))assert.ok(Number(width)>=3*72/203-1e-6,`${where}: line ${width} pt is under 3 dots`);
 }
 const logo=await loadImage(Buffer.from(FAIZ_LOGO.src.split(',')[1],'base64')),canvas=createCanvas(logo.width,logo.height),context=canvas.getContext('2d');
 context.drawImage(logo,0,0);const pixels=context.getImageData(0,0,logo.width,logo.height).data;
 for(let i=0;i<pixels.length;i+=4)if(pixels[i+3])assert.ok(pixels[i+3]===255&&!pixels[i]&&!pixels[i+1]&&!pixels[i+2],'the logo is solid black with hard edges');
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
