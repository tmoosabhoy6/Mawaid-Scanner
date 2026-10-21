import test from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { makeLabels, makeSafariLabels } from '../src/labels.js';
import { graphicField, labelZpl, pdfToZpl, testZpl, saveMediaZpl, dots } from '../src/zebra.js';
import { decodeLabels, blackDots } from './zpl-decode.js';
const settings = { widthMm: 76.2, heightMm: 50.8 }, fonts = { standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname };
const sample = { token: 'A'.repeat(43), tour_id: '26/1234', office: 'FH Kuwait', person_no: 1, arrival: '2026-10-21', departure: '2026-10-24', printed_at: '2026-10-21T04:00:00Z' };
test('ZPL graphics compress losslessly: blank, solid, repeated and patterned rows', () => {
  const width = 609, height = 40, data = new Uint8ClampedArray(width * height * 4).fill(255), bits = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const black = y >= 30 ? false : y >= 20 ? true : y >= 10 ? (x * 7 + y * 13) % 5 < 2 : x > 500;
    bits.push(black); if (black) data.set([0, 0, 0], (y * width + x) * 4);
  }
  const [label] = decodeLabels(labelZpl(graphicField({ width, height, data }), settings));
  assert.equal(label.rowBytes, 77); assert.equal(label.rows.length, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) assert.equal(!!((parseInt(label.rows[y][x >> 2], 16) >> (3 - (x & 3))) & 1), bits[y * width + x], `dot ${x},${y}`);
});
test('each 3 × 2 inch sticker becomes one gap-sensed, direct-thermal ZPL label of 609 × 406 dots', async () => {
  assert.equal(dots(76.2), 609); assert.equal(dots(50.8), 406);
  const cards = await pdfToZpl(pdfjs, new Uint8Array(await makeLabels([sample, { ...sample, person_no: 2 }], settings)), settings, fonts);
  const safari = await pdfToZpl(pdfjs, new Uint8Array(await makeSafariLabels([{ arrival: '2026-10-21', departure: '2026-10-24', pax: 12 }], settings)), settings, fonts);
  for (const [zpl, count] of [[cards, 2], [safari, 1]]) {
    const formats = zpl.trim().split('\n');
    assert.equal(formats.length, count, 'one ^XA…^XZ per sticker');
    for (const f of formats) assert.match(f, /^\^XA\^MNY\^MTD\^MMT\^PON\^LH0,0\^PW609\^LL406\^FO0,0\^GFA,31262,31262,77,[^^]+\^FS\^PQ1\^XZ$/);
    for (const label of decodeLabels(zpl)) {
      assert.equal(label.rows.length, 406);
      // Printed ink covers a real share of the sticker: never blank, never a solid black block.
      const share = blackDots(label) / (609 * 406);
      assert.ok(share > .08 && share < .4, `${(share * 100).toFixed(1)}% of dots are black`);
    }
  }
  assert.ok(cards.length < 2 * 40000, `a label is ${cards.length / 2} characters`);
});
test('printer tools: test sticker, saved gap-label settings', () => {
  assert.match(testZpl(settings), /^\^XA\^MNY\^MTD\^MMT\^PON\^LH0,0\^PW609\^LL406\^FO8,8\^GB593,390,4\^FS.*Mawaid printer test.*\^PQ1\^XZ\n$/);
  assert.equal(saveMediaZpl(settings), '^XA^MNY^MTD^MMT^PON^LH0,0^PW609^LL406^JUS^XZ\n');
});
