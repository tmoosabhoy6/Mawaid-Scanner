import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
const mm = n => n * 72 / 25.4;
export const tokenText = token => `MW1:${token}`;
export async function makeLabels(cards, settings) {
  const { widthMm = 60, heightMm = 90 } = settings;
  const doc = new PDFDocument({ size: [mm(widthMm), mm(heightMm)], margin: mm(4), autoFirstPage: false });
  const chunks = []; doc.on('data', chunk => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  for (const c of cards) {
    doc.addPage();
    const w = mm(widthMm), h = mm(heightMm);
    doc.lineWidth(1).strokeColor('#781b39').rect(mm(2), mm(2), w - mm(4), h - mm(4)).stroke();
    doc.fillColor('#781b39').font('Helvetica-Bold').fontSize(12).text('FAIZE HUSSEINI', mm(4), mm(6), { width: w - mm(8), align: 'center' });
    doc.fontSize(10).text('KARBALA MUALLA', { width: w - mm(8), align: 'center' });
    const qr = await QRCode.toBuffer(tokenText(c.token), { errorCorrectionLevel: 'M', margin: 4, width: 600 });
    const qrSize = Math.min(w - mm(12), h * .43);
    doc.image(qr, (w - qrSize) / 2, mm(20), { width: qrSize, height: qrSize });
    const y = mm(21) + qrSize;
    doc.fillColor('#111').font('Helvetica').fontSize(8);
    const lines = [`Tour: ${c.tour_id}`, `Office: ${c.office}`, `Person: ${c.person_no}`, `Arrival: ${c.arrival}`, `Departure: ${c.departure}`, `Printed: ${new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(c.printed_at))} KRB`];
    lines.forEach((line, i) => doc.text(line, mm(5), y + i * 11, { width: w - mm(10), height: 10, ellipsis: true, lineBreak: false }));
  }
  doc.end(); return complete;
}
// Rasterized PDF is used for QZ printing, so office text cannot inject printer commands.
