import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { JSDOM,VirtualConsole } from 'jsdom';
import { createCanvas } from '@napi-rs/canvas';

test('browser PDF bundle generates the confirmed 3 by 2 inch label without Node APIs',async()=>{
 const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{runScripts:'outside-only',url:'https://mawayid.test',virtualConsole:console});
 try{
 const original=dom.window.document.createElement.bind(dom.window.document);
 dom.window.document.createElement=name=>name==='canvas'?createCanvas(1,1):original(name);
 dom.window.Blob=Blob;
 dom.window.eval(readFileSync('public/vendor/pdf.js','utf8'));
 const sample={token:'A'.repeat(43),tour_id:'26/1234',office:'FH Kuwait',person_no:1,arrival:'2026-10-21',departure:'2026-10-24',printed_at:'2026-10-21T04:00:00Z'};
 const pdf=await dom.window.generateMawaidPdf([sample],{widthMm:76.2,heightMm:50.8});
 const buffer=Buffer.from(await pdf.arrayBuffer());assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.ok(buffer.length>1000);assert.deepEqual(errors,[]);
 if(process.env.LABEL_TEST_OUTPUT){mkdirSync(process.env.LABEL_TEST_OUTPUT,{recursive:true});writeFileSync(process.env.LABEL_TEST_OUTPUT+'/browser-label.pdf',buffer);}
 }finally{dom.window.close();}
});
