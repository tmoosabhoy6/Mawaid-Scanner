import PDFDocument from 'pdfkit/js/pdfkit.standalone.js';
import QRCode from 'qrcode/lib/browser.js';
import { drawLabels, drawSafariLabels } from '../src/label-layout.js';
const mm=n=>n*72/25.4;
function pdfFor(settings,margin){
 const doc=new PDFDocument({size:[mm(settings.widthMm),mm(settings.heightMm)],margin,autoFirstPage:false});
 const chunks=[];doc.on('data',chunk=>chunks.push(chunk));
 const result=new Promise((resolve,reject)=>{doc.on('end',()=>resolve(new Blob(chunks,{type:'application/pdf'})));doc.on('error',reject);});
 return {doc,result};
}
window.generateMawaidPdf=async(cards,settings)=>{
 const {doc,result}=pdfFor(settings,mm(3));
 await drawLabels(doc,cards,settings,(text,options)=>QRCode.create(text,options));
 doc.end();return result;
};
// Safari stickers carry no QR code, so they are drawn here and printed straight away.
window.generateSafariPdf=async(safaris,settings)=>{
 const {doc,result}=pdfFor(settings,0);
 drawSafariLabels(doc,safaris,settings);
 doc.end();return result;
};
