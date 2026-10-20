import PDFDocument from 'pdfkit/js/pdfkit.standalone.js';
import QRCode from 'qrcode/lib/browser.js';
import { drawLabels } from '../src/label-layout.js';
window.generateMawaidPdf=async(cards,settings)=>{
 const mm=n=>n*72/25.4;
 const doc=new PDFDocument({size:[mm(settings.widthMm),mm(settings.heightMm)],margin:mm(3),autoFirstPage:false});
 const chunks=[];doc.on('data',chunk=>chunks.push(chunk));
 const result=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(new Blob(chunks,{type:'application/pdf'})));doc.on('error',reject);});
 await drawLabels(doc,cards,settings,(text,options)=>QRCode.create(text,options));
 doc.end();return result;
};
