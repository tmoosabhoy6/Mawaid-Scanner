import { KARBALA_CALLIGRAPHY as ART } from './karbala-calligraphy.js';
import { FAIZ_LOGO as LOGO } from './faiz-e-husaini-logo.js';
const mm = n => n * 72 / 25.4;
// The ZD220D is monochrome: any colour or grey is halftoned into scattered dots by the driver, so every mark on the
// meal card is solid black like the QR code. Lines are 3 printer dots thick with their edges on the dot grid.
const INK = '#000', DOT = 72 / 203, LINE = 3 * DOT, QUIET = 4;
const onDots = v => (Math.floor(v / DOT) + .5) * DOT;
// Thin text strokes break up at 203 dpi, so all text is bold and outlined in black, adding a printer dot to every
// stroke. bold(doc, font, size) sets the font and outline; pass BOLD with each text call.
const OUTLINE = DOT, BOLD = { fill: true, stroke: true };
const bold = (doc, font, size) => doc.font(font).fontSize(size).fillColor(INK).strokeColor(INK).lineWidth(OUTLINE);
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
    doc._karbalaArt = doc.ref({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, ART.width, ART.height], Resources: { ProcSet: ['PDF'] } });
    doc._karbalaArt.end(`0 0 0 rg\n${artStream()}`);
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
    bold(doc, 'Helvetica-Bold', size);
    const caption = `${label}: `, captionWidth = doc.widthOfString(caption);
    doc.text(caption, x, y + i * spacing, { ...BOLD, lineBreak: false });
    doc.text(fit(doc, String(value), width - captionWidth), x + captionWidth, y + i * spacing, { ...BOLD, lineBreak: false });
  });
}
// Largest size (up to max) at which a full departure line fits, so dates are never truncated.
function detailSize(doc, width, max) {
  doc.font('Helvetica-Bold').fontSize(10);
  return Math.min(max, 10 * width / doc.widthOfString('Departure: 0000-00-00'));
}
export async function drawLabels(doc, cards, settings, createQr) {
  const { widthMm = 76.2, heightMm = 50.8 } = settings;
  const w = mm(widthMm), h = mm(heightMm), compact = heightMm < 80;
  for (const c of cards) {
    doc.addPage();
    const qr = await createQr(`MW1:${c.token}`, { errorCorrectionLevel: 'M' });
    const printed = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(c.printed_at)).replace(',', '');
    const lines = [['Tour', c.tour_id || '—'], ['Office', c.office], ['Person', c.person_no], ['Arrival', c.arrival], ['Departure', c.departure]];
    const inset = onDots(mm(2));
    doc.lineWidth(LINE).strokeColor(INK).rect(inset, inset, w - inset * 2, h - inset * 2).stroke();
    if (compact) {
      // QR on the left at full height; calligraphy heads the guest details on the right.
      const qrMm = Math.min(heightMm - 7, widthMm - 39), qrTop = (heightMm - qrMm) / 2;
      drawQr(doc, qr, mm(3), mm(qrTop), mm(qrMm));
      const x = mm(4 + qrMm), colW = w - x - mm(3.5), artW = Math.min(colW * .92, mm(30));
      let y = mm(3.6) + drawArt(doc, x + (colW - artW) / 2, mm(3.6), artW);
      bold(doc, 'Helvetica-Bold', 6).text('FAIZ-E-HUSAINI', x, y + mm(.9), { ...BOLD, width: colW, align: 'center', characterSpacing: .6, lineBreak: false });
      y = onDots(y + mm(4.4));
      doc.moveTo(x + mm(2), y).lineTo(x + colW - mm(2), y).lineWidth(LINE).strokeColor(INK).stroke();
      const spacing = mm(3.85); y += mm(1.4);
      details(doc, lines, x, y, colW, detailSize(doc, colW, 7), spacing);
      const stamp = `Printed: ${printed} Karbala`;
      bold(doc, 'Helvetica-Bold', sizeFor(doc, 'Helvetica-Bold', stamp, colW * .98, 5.8)).text(fit(doc, stamp, colW), x, y + lines.length * spacing + mm(.4), { ...BOLD, lineBreak: false });
    } else {
      // Portrait labels follow the reference sticker: calligraphy, society name, QR, then details.
      const textW = w - mm(10), size = detailSize(doc, textW, 11), spacing = size * 1.45;
      const artW = Math.min(w - mm(12), w * .72);
      let y = mm(4.5) + drawArt(doc, (w - artW) / 2, mm(4.5), artW);
      const nameSize = Math.min(size, 9);
      bold(doc, 'Helvetica-Bold', nameSize).text('FAIZ-E-HUSAINI', mm(4), y + mm(1.2), { ...BOLD, width: w - mm(8), align: 'center', characterSpacing: nameSize / 10, lineBreak: false });
      y += mm(2.4) + nameSize * 1.2;
      // Reserve the detail block and a bottom margin before sizing the QR, so a label never spills onto a second page.
      const room = h - mm(5) - y - (lines.length + 1) * spacing;
      const qrSize = Math.min(w - mm(8), room), block = qrSize + (lines.length + 1) * spacing;
      y += Math.max(0, (h - mm(5) - y - block) / 2);
      drawQr(doc, qr, (w - qrSize) / 2, y, qrSize);
      y += qrSize;
      details(doc, lines, mm(5), y, textW, size, spacing);
      const stamp = `Printed: ${printed} Karbala`;
      bold(doc, 'Helvetica-Bold', sizeFor(doc, 'Helvetica-Bold', stamp, textW * .98, size * .75)).text(fit(doc, stamp, textW), mm(5), y + lines.length * spacing + size * .2, { ...BOLD, lineBreak: false });
    }
  }
}
// Safari (takeaway) sticker: the printed Lunch/Dinner card without a QR code.
// Left: two star-pattern arches behind a medallion holding the society logo. Right: DATE, Izan Card, Lunch/Dinner and PAX.
// As on the meal card, every mark is solid black (the card's navy, blue and gold would be halftoned into dots) and every
// line, black or white, is at least 3 printer dots thick.
const shortDate = (value, year) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) }).format(new Date(`${value}T00:00:00Z`));
export function safariDates(arrival, departure) {
  if (arrival && departure) return arrival.slice(0, 4) === departure.slice(0, 4) ? `${shortDate(arrival)} – ${shortDate(departure, true)}` : `${shortDate(arrival, true)} – ${shortDate(departure, true)}`;
  if (arrival) return `from ${shortDate(arrival, true)}`;
  return departure ? `until ${shortDate(departure, true)}` : '';
}
// An ogee arch of width w on axis cx: its point at apexY, its straight sides ending at baseY (above or below).
// As on the card, the pointed cap sits on a small ledge, slightly wider than the straight body.
function archPath(doc, cx, w, apexY, baseY) {
  const dir = Math.sign(baseY - apexY), k = w * .38, shoulder = apexY + dir * k, l = cx - w / 2, r = cx + w / 2, body = w * .46;
  doc.moveTo(cx - body, baseY).lineTo(cx - body, shoulder).lineTo(l, shoulder)
    .bezierCurveTo(l, shoulder - dir * k * .45, cx - w * .12, apexY + dir * k * .3, cx, apexY)
    .bezierCurveTo(cx + w * .12, apexY + dir * k * .3, r, shoulder - dir * k * .45, r, shoulder)
    .lineTo(cx + body, shoulder).lineTo(cx + body, baseY).closePath();
}
// Eight-pointed stars on a square lattice, joined across each gap: the girih lines of the printed card.
function starLattice(doc, cx, cy, s, box) {
  const R = s / 2, inner = R * Math.cos(Math.PI / 4) / Math.cos(Math.PI / 8);
  for (let gx = Math.floor((box.x0 - cx) / s) - 1; gx * s + cx <= box.x1 + s; gx++) for (let gy = Math.floor((box.y0 - cy) / s) - 1; gy * s + cy <= box.y1 + s; gy++) {
    const x = cx + gx * s, y = cy + gy * s;
    for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, d = i % 2 ? inner : R; doc[i ? 'lineTo' : 'moveTo'](x + d * Math.cos(a), y + d * Math.sin(a)); }
    doc.closePath();
    for (const a of [1, 3, 5, 7].map(n => n * Math.PI / 4)) doc.moveTo(x + R * Math.cos(a), y + R * Math.sin(a)).lineTo(x + s * Math.SQRT1_2 * Math.cos(a), y + s * Math.SQRT1_2 * Math.sin(a));
  }
}
function drawPanel(doc, cx, cy, D, top, bottom) {
  const R = D / 2, aw = D * .74, gap = mm(.55);
  for (const [apex, dir] of [[top, 1], [bottom, -1]]) {
    archPath(doc, cx, aw + gap * 2.6, apex - dir * gap * 1.3, cy); doc.lineWidth(LINE).strokeColor(INK).stroke();
    doc.save(); archPath(doc, cx, aw, apex, cy); doc.clip();
    doc.rect(cx - aw, Math.min(apex, cy), aw * 2, Math.abs(cy - apex)).fill(INK);
    starLattice(doc, cx, cy, aw / 4.2, { x0: cx - aw / 2, x1: cx + aw / 2, y0: Math.min(apex, cy), y1: Math.max(apex, cy) });
    doc.lineWidth(LINE).strokeColor('#fff').stroke(); doc.restore();
  }
  // Medallion: white disc over the arches, an interlaced zigzag band, then the logo.
  doc.circle(cx, cy, R).fill('#fff');
  doc.lineWidth(LINE).strokeColor(INK);
  doc.circle(cx, cy, R - mm(.2)).stroke(); doc.circle(cx, cy, R - mm(2.7)).stroke();
  const teeth = Math.max(24, Math.round(D / mm(1.05)));
  for (const shift of [0, 1]) {
    for (let i = 0; i <= teeth * 2; i++) { const a = (i / (teeth * 2)) * Math.PI * 2, d = (i + shift) % 2 ? R - mm(.75) : R - mm(2.15); doc[i ? 'lineTo' : 'moveTo'](cx + d * Math.cos(a), cy + d * Math.sin(a)); }
    doc.stroke();
  }
  const logoW = (R - mm(3.1)) * 2 * .86, logoH = logoW * LOGO.height / LOGO.width;
  doc.image(LOGO.src, cx - logoW / 2, cy - logoH / 2, { width: logoW });
}
// Largest font size up to max at which text fits in width.
function sizeFor(doc, font, text, width, max) { doc.font(font).fontSize(10); return Math.min(max, 10 * width / Math.max(1, doc.widthOfString(text))); }
// "DATE:" or "PAX:" with its value, or a rule to write on when the value is blank.
function captioned(doc, caption, value, x, centerY, width, size) {
  bold(doc, 'Times-Bold', size);
  const label = `${caption}: `, labelW = doc.widthOfString(label), top = centerY - size * .5;
  doc.text(label, x, top, { ...BOLD, lineBreak: false });
  if (value) {
    const valueSize = Math.min(size, sizeFor(doc, 'Times-Bold', value, width - labelW, size));
    bold(doc, 'Times-Bold', valueSize).text(value, x + labelW, centerY - valueSize * .5, { ...BOLD, lineBreak: false });
  } else doc.moveTo(x + labelW, centerY + size * .42).lineTo(x + width, centerY + size * .42).lineWidth(LINE).strokeColor(INK).stroke();
}
export function drawSafariLabels(doc, safaris, settings) {
  const { widthMm = 76.2, heightMm = 50.8 } = settings;
  const w = mm(widthMm), h = mm(heightMm), m = mm(1.8), landscape = w >= h * .9;
  for (const s of safaris) {
    doc.addPage();
    const dates = safariDates(s.arrival, s.departure), pax = s.pax ? String(s.pax) : '';
    let x, width, rows;
    if (landscape) {
      const D = Math.min((h - 2 * m) * .52, w * .36), cx = m + mm(.5) + D / 2;
      drawPanel(doc, cx, h / 2, D, m, h - m);
      x = cx + D / 2 + mm(2.2); width = w - m - mm(.5) - x;
      rows = { date: h * .18, name: h * .38, meal: h * .56, pax: h * .79 };
    } else {
      const panelH = h * .46, D = Math.min(panelH * .52, w * .62);
      drawPanel(doc, w / 2, m + panelH / 2, D, m, m + panelH);
      x = m + mm(1.5); width = w - 2 * x;
      const t = m + panelH + mm(1.5), rest = h - m - t;
      rows = { date: t + rest * .12, name: t + rest * .36, meal: t + rest * .6, pax: t + rest * .86 };
    }
    const meal = 'Lunch/Dinner', mealSize = sizeFor(doc, 'Times-Bold', meal, width, mm(8.5)), small = Math.min(mealSize * .46, 11);
    captioned(doc, 'DATE', dates, x, rows.date, width, small);
    // Every Safari sticker is headed "Izan Card", as printed on the card; the office name is not printed.
    const title = 'Izan Card', titleSize = sizeFor(doc, 'Times-Bold', title, width, mealSize * .62);
    bold(doc, 'Times-Bold', titleSize).text(title, x, rows.name - titleSize * .5, { ...BOLD, width, align: 'center', lineBreak: false });
    bold(doc, 'Times-Bold', mealSize).text(meal, x, rows.meal - mealSize * .5, { ...BOLD, width, align: 'center', lineBreak: false });
    captioned(doc, 'PAX', pax, x, rows.pax, width * .62, small * 1.15);
  }
}
