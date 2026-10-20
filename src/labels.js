import { drawLabels } from './label-layout.js';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
const mm = n => n * 72 / 25.4;
export const tokenText = token => `MW1:${token}`;
export async function makeLabels(cards, settings = {}) {
  const { widthMm = 76.2, heightMm = 50.8 } = settings;
  const doc = new PDFDocument({ size: [mm(widthMm), mm(heightMm)], margin: mm(3), autoFirstPage: false });
  const chunks = []; doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  await drawLabels(doc,cards,settings,(text,options)=>QRCode.create(text,options));
  doc.end(); return complete;
}
// QZ Tray rasterizes this PDF, so office text cannot inject printer commands.
