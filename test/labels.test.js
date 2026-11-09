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
test('meal cards and Safari stickers print only solid black, with lines at least 3 printer dots thick and bold, outlined text',async()=>{
 const kinds={'meal card':(doc,size)=>drawLabels(doc,[sample],size,(t,o)=>QRCode.create(t,o)),'Safari sticker':(doc,size)=>drawSafariLabels(doc,[{arrival:'2026-10-21',departure:'2026-10-24',pax:12},{}],size)};
 for(const [kind,draw] of Object.entries(kinds))for(const [widthMm,heightMm] of [[76.2,50.8],[104,200]]){
  const text=await uncompressed(draw,widthMm,heightMm),where=`${kind} ${widthMm} × ${heightMm} mm`,colours=[...text.matchAll(/^([\d. ]+) (scn|SCN|sc|SC|rg|RG|g|G|k|K)$/gm)];
  assert.ok(colours.length>5);
  // Black ink, or white where the pattern lines cross the black arches.
  for(const [op,values] of colours)assert.ok(/^(0 0 0|1 1 1) /.test(op),`${where}: ${op}`);
  // Text is outlined by half a printer dot; every other line is at least 3 dots.
  for(const [,width] of text.matchAll(/^([\d.]+) w$/gm))assert.ok(Math.abs(width-36/203)<1e-6||Number(width)>=3*72/203-1e-6,`${where}: line ${width} pt is under 3 dots`);
  // Thin strokes break up at 203 dpi: every font is bold and all text is filled and outlined (2 Tr).
  for(const [,font] of text.matchAll(/\/BaseFont \/(\S+)/g))assert.match(font,/-Bold$/,`${where}: ${font}`);
  const blocks=text.match(/^BT$[\s\S]*?^ET$/gm);assert.ok(blocks.length>3);
  for(const block of blocks)assert.match(block,/^2 Tr$/m,`${where}: text is not outlined`);
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
// The tour ID prints larger than the other details, yet every line stays inside the frame and clear of its neighbours,
// at every supported label size and with a tour ID too long to enlarge. The printed date stamp is no longer on the card.
test('the tour ID is enlarged within the label and no text leaves the frame or overlaps',async()=>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),standardFontDataUrl=new URL('../node_modules/pdfjs-dist/standard_fonts/',import.meta.url).pathname;
 const pt=mm=>mm*72/25.4,ASC=.718,DESC=.207;
 for(const tour_id of ['26/1234','KRB-2026/1234567890'])for(const [widthMm,heightMm] of [[40,80],[70,50.8],[76.2,50.8],[104,200]]){
  const where=`${tour_id} on ${widthMm} × ${heightMm} mm`,pdf=await pdfjs.getDocument({data:new Uint8Array(await makeLabels([{...sample,tour_id}],{widthMm,heightMm})),isEvalSupported:false,standardFontDataUrl}).promise;
  try{
   assert.equal(pdf.numPages,1,where);
   const {items}=await(await pdf.getPage(1)).getTextContent(),text=items.filter(i=>i.str.trim()).map(i=>({str:i.str,size:i.transform[0],x:i.transform[4],base:i.transform[5],width:i.width}));
   assert.ok(!text.some(i=>/Printed/.test(i.str)),`${where}: the printed stamp is gone`);
   // Inside the frame, which is drawn 2 mm in from each edge.
   for(const i of text){assert.ok(i.x>=pt(2)&&i.x+i.width<=pt(widthMm-2),`${where}: "${i.str}" runs past the side of the frame`);assert.ok(i.base-i.size*DESC>=pt(2)&&i.base+i.size*ASC<=pt(heightMm-2),`${where}: "${i.str}" runs past the top or bottom of the frame`);}
   // pdf.js merges the caption and value into one item when a long ID has fallen back to the ordinary size.
   const merged=text.find(i=>i.str.startsWith('Tour: ')&&i.str.length>6),caption=merged||text.find(i=>i.str.trim()==='Tour:'),value=merged||text.find(i=>i!==caption&&i.str.length>1&&tour_id.startsWith(i.str.replace('…','')));
   assert.ok(caption&&value,`${where}: tour line found`);
   // Larger than its caption (when the ID is short enough), never smaller, and on the same baseline.
   assert.ok(value.size>=caption.size-1e-6&&value.size<=caption.size*1.3+1e-6,`${where}: tour ID size ${value.size}`);
   if(tour_id==='26/1234')assert.ok(value.size>caption.size*1.25,`${where}: the tour ID is enlarged`);
   assert.ok(Math.abs(value.base-caption.base)<1e-6,`${where}: tour ID shares the caption's baseline`);
   // Each detail line clears the next one, and the tour ID clears the society name above it.
   const lines=['FAIZ-E-HUSAINI','Tour','Office','PAX','Arrival','Departure'].map(start=>start==='Tour'?value:text.find(i=>i.str.startsWith(start)));
   for(let n=1;n<lines.length;n++){const above=lines[n-1],below=lines[n];assert.ok(above.base-above.size*DESC>below.base+below.size*ASC,`${where}: "${above.str}" overlaps "${below.str}"`);}
  }finally{await pdf.destroy();}
 }
});
