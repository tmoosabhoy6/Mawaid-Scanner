// Zebra ZPL for the ZD220D (203 dpi, direct thermal). Each sticker is sent as its own ^XA…^XZ label with the
// media settings written into it, so a wrong driver paper size or media type can no longer feed blank labels.
export const ZEBRA_DPI = 203;
export const dots = mm => Math.round(mm / 25.4 * ZEBRA_DPI);
const COUNTS = 'GHIJKLMNOPQRSTUVWXY', TWENTIES = 'ghijklmnopqrstuvwxyz';
// ZPL ASCII run-length code for n repeats of one hex digit (n ≥ 1).
function run(char, n) {
  let out = '';
  while (n > 0) {
    const take = Math.min(n, 419), high = Math.floor(take / 20), low = take % 20;
    out += take === 1 ? char : `${high ? TWENTIES[high - 1] : ''}${low ? COUNTS[low - 1] : ''}${char}`; n -= take;
  }
  return out;
}
function compressRow(hex, previous) {
  if (hex === previous) return ':';
  const body = hex.replace(/0+$/, ''), zeros = body.length < hex.length;
  if (!body) return ',';
  let out = '';
  for (let i = 0; i < body.length;) { let j = i; while (j < body.length && body[j] === body[i]) j++; out += run(body[i], j - i); i = j; }
  return zeros ? `${out},` : out;
}
// image: {width, height, data} RGBA pixels (canvas ImageData). Dark pixels print; the maroon artwork prints black.
export function graphicField(image, threshold = 160) {
  const { width, height, data } = image, rowBytes = Math.ceil(width / 8), rows = [];
  let previous = null;
  for (let y = 0; y < height; y++) {
    let hex = '';
    for (let b = 0; b < rowBytes; b++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = b * 8 + bit; if (x >= width) continue;
        const p = (y * width + x) * 4, a = data[p + 3] / 255;
        const luma = 255 - a * (255 - (data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114));
        if (luma < threshold) byte |= 0x80 >> bit;
      }
      hex += byte.toString(16).toUpperCase().padStart(2, '0');
    }
    rows.push(compressRow(hex, previous)); previous = hex;
  }
  const total = rowBytes * height;
  return `^GFA,${total},${total},${rowBytes},${rows.join('')}`;
}
// Gap (die-cut) labels, direct thermal, tear-off, label size in dots. ^PQ1 prints one copy of each label.
export const mediaSetup = settings => `^MNY^MTD^MMT^PON^LH0,0^PW${dots(settings.widthMm)}^LL${dots(settings.heightMm)}`;
export const labelZpl = (field, settings) => `^XA${mediaSetup(settings)}^FO0,0${field}^FS^PQ1^XZ\n`;
// Saves the gap-label settings in the printer; ~JC then measures the labels (it feeds one to four).
export const saveMediaZpl = settings => `^XA${mediaSetup(settings)}^JUS^XZ\n`;
export const CALIBRATE_ZPL = '~JC';
// Cancels every label still in the printer's memory, stopping a run of stickers.
export const CANCEL_ZPL = '~JA';
export function testZpl(settings) {
  const w = dots(settings.widthMm), h = dots(settings.heightMm);
  return `^XA${mediaSetup(settings)}^FO8,8^GB${w - 16},${h - 16},4^FS^FO32,${Math.round(h * .22)}^A0N,44,44^FDMawaid printer test^FS^FO32,${Math.round(h * .45)}^A0N,26,26^FDOne label per sticker, frame inside the edges^FS^FO32,${Math.round(h * .62)}^A0N,26,26^FD${settings.widthMm} x ${settings.heightMm} mm^FS^PQ1^XZ\n`;
}
// Renders every PDF page at 203 dpi and returns one ZPL label per page.
// pdfjs is the pdf.js module; its own canvas factory draws in the browser and in tests.
export async function pdfToZpl(pdfjs, bytes, settings, documentOptions = {}) {
  const w = dots(settings.widthMm), h = dots(settings.heightMm);
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, ...documentOptions }).promise;
  try {
    let zpl = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(w / base.width, h / base.height) });
      const { canvas, context } = pdf.canvasFactory.create(w, h);
      context.fillStyle = '#fff'; context.fillRect(0, 0, w, h);
      await page.render({ canvasContext: context, canvas, viewport, intent: 'print' }).promise;
      zpl += labelZpl(graphicField(context.getImageData(0, 0, w, h)), settings);
      pdf.canvasFactory.destroy({ canvas, context }); page.cleanup();
    }
    return zpl;
  } finally { await pdf.destroy(); }
}
