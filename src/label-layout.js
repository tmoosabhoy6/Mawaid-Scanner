import { KARBALA_CALLIGRAPHY as ART } from './karbala-calligraphy.js';
const mm = n => n * 72 / 25.4;
const MAROON = ART.color, QUIET = 4;
// Convert the absolute SVG path into PDF path operators once per process.
let artOperators;
function artStream() {
  if (artOperators) return artOperators;
  const out = [], tokens = ART.path.match(/[MCLZ]|-?\d+(?:\.\d+)?/g); let op = 'M';
  for (let i = 0; i < tokens.length;) {
    if (/[MCLZ]/.test(tokens[i])) { op = tokens[i++]; if (op === 'Z') { out.push('h'); continue; } }
    const count = op === 'C' ? 6 : 2;
    out.push(`${tokens.slice(i, i + count).join(' ')} ${{ M: 'm', L: 'l', C: 'c' }[op]}`); i += count;
  }
  return artOperators = `${out.join('\n')}\nf`;
}
// The calligraphy is stored once per PDF as a form XObject and reused on every label page.
function drawArt(doc, x, y, width) {
  if (!doc._karbalaArt) {
    const [r, g, b] = [1, 3, 5].map(i => (parseInt(MAROON.slice(i, i + 2), 16) / 255).toFixed(3));
    doc._karbalaArt = doc.ref({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, ART.width, ART.height], Resources: { ProcSet: ['PDF'] } });
    doc._karbalaArt.end(`${r} ${g} ${b} rg\n${artStream()}`);
  }
  doc.page.xobjects.KarbalaArt = doc._karbalaArt;
  const scale = width / ART.width;
  doc.save().translate(x, y).scale(scale); doc.addContent('/KarbalaArt Do'); doc.restore();
  return ART.height * scale;
}
// Vector QR modules print crisply at 203 dpi and keep each saved PDF small.
function drawQr(doc, qr, x, y, size) {
  const n = qr.modules.size, data = qr.modules.data, unit = size / (n + QUIET * 2);
  doc.save();
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
    if (!data[row * n + col]) continue;
    let end = col; while (end + 1 < n && data[row * n + end + 1]) end++;
    // A hairline overlap between rows prevents raster seams inside merged dark areas.
    doc.rect(x + (QUIET + col) * unit, y + (QUIET + row) * unit, (end - col + 1) * unit, unit + .05);
    col = end;
  }
  doc.fillColor('#000').fill().restore();
}
function fit(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  while (text.length > 1 && doc.widthOfString(`${text}…`) > width) text = text.slice(0, -1);
  return `${text.trimEnd()}…`;
}
function details(doc, lines, x, y, width, size, spacing) {
  lines.forEach(([label, value], i) => {
    doc.font('Helvetica').fontSize(size).fillColor('#333');
    const caption = `${label}: `, captionWidth = doc.widthOfString(caption);
    doc.text(caption, x, y + i * spacing, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor('#000');
    doc.text(fit(doc, String(value), width - captionWidth), x + captionWidth, y + i * spacing, { lineBreak: false });
  });
}
// Largest size (up to max) at which a full departure line fits, so dates are never truncated.
function detailSize(doc, width, max) {
  doc.fontSize(10); const caption = doc.font('Helvetica').widthOfString('Departure: '), value = doc.font('Helvetica-Bold').widthOfString('0000-00-00');
  return Math.min(max, 10 * width / (caption + value));
}
export async function drawLabels(doc, cards, settings, createQr) {
  const { widthMm = 76.2, heightMm = 50.8 } = settings;
  const w = mm(widthMm), h = mm(heightMm), compact = heightMm < 80;
  for (const c of cards) {
    doc.addPage();
    const qr = await createQr(`MW1:${c.token}`, { errorCorrectionLevel: 'M' });
    const printed = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(c.printed_at)).replace(',', '');
    const lines = [['Tour', c.tour_id], ['Office', c.office], ['Person', c.person_no], ['Arrival', c.arrival], ['Departure', c.departure]];
    doc.lineWidth(.8).strokeColor(MAROON).rect(mm(2), mm(2), w - mm(4), h - mm(4)).stroke();
    if (compact) {
      // QR on the left at full height; calligraphy heads the guest details on the right.
      const qrMm = Math.min(heightMm - 7, widthMm - 39), qrTop = (heightMm - qrMm) / 2;
      drawQr(doc, qr, mm(3), mm(qrTop), mm(qrMm));
      const x = mm(4 + qrMm), colW = w - x - mm(3.5), artW = Math.min(colW * .92, mm(30));
      let y = mm(3.6) + drawArt(doc, x + (colW - artW) / 2, mm(3.6), artW);
      doc.font('Helvetica-Bold').fontSize(6).fillColor(MAROON).text('FAIZ-E-HUSAINI', x, y + mm(.9), { width: colW, align: 'center', characterSpacing: .6, lineBreak: false });
      y += mm(4.4);
      doc.moveTo(x + mm(2), y).lineTo(x + colW - mm(2), y).lineWidth(.7).strokeColor(MAROON).stroke();
      const spacing = mm(3.85); y += mm(1.4);
      details(doc, lines, x, y, colW, detailSize(doc, colW, 7), spacing);
      doc.font('Helvetica').fontSize(5.8).fillColor('#222').text(fit(doc, `Printed: ${printed} Karbala`, colW), x, y + lines.length * spacing + mm(.4), { lineBreak: false });
    } else {
      // Portrait labels follow the reference sticker: calligraphy, society name, QR, then details.
      const textW = w - mm(10), size = detailSize(doc, textW, 11), spacing = size * 1.45;
      const artW = Math.min(w - mm(12), w * .72);
      let y = mm(4.5) + drawArt(doc, (w - artW) / 2, mm(4.5), artW);
      const nameSize = Math.min(size, 9);
      doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(MAROON).text('FAIZ-E-HUSAINI', mm(4), y + mm(1.2), { width: w - mm(8), align: 'center', characterSpacing: nameSize / 10, lineBreak: false });
      y += mm(2.4) + nameSize * 1.2;
      // Reserve the detail block and a bottom margin before sizing the QR, so a label never spills onto a second page.
      const room = h - mm(5) - y - (lines.length + 1) * spacing;
      const qrSize = Math.min(w - mm(8), room), block = qrSize + (lines.length + 1) * spacing;
      y += Math.max(0, (h - mm(5) - y - block) / 2);
      drawQr(doc, qr, (w - qrSize) / 2, y, qrSize);
      y += qrSize;
      details(doc, lines, mm(5), y, textW, size, spacing);
      doc.font('Helvetica').fontSize(size * .75).fillColor('#222').text(fit(doc, `Printed: ${printed} Karbala`, textW), mm(5), y + lines.length * spacing + size * .2, { lineBreak: false });
    }
  }
}
