// Decodes the ^GFA graphics written by src/zebra.js back into rows of bits, so tests can check what the printer would print.
const COUNTS = 'GHIJKLMNOPQRSTUVWXY', TWENTIES = 'ghijklmnopqrstuvwxyz';
export function decodeLabels(zpl) {
  return [...zpl.matchAll(/\^GFA,(\d+),(\d+),(\d+),([^^]*)\^FS/g)].map(([, total, , rowBytes, data]) => {
    const width = Number(rowBytes) * 2, rows = []; let row = '', count = 0;
    const finish = fill => { rows.push((row + fill.repeat(width)).slice(0, width)); row = ''; };
    for (const c of data) {
      if (c === ':') { rows.push(rows.at(-1)); continue; }
      if (c === ',') { finish('0'); continue; }
      if (c === '!') { finish('F'); continue; }
      const low = COUNTS.indexOf(c), high = TWENTIES.indexOf(c);
      if (low >= 0) { count += low + 1; continue; }
      if (high >= 0) { count += (high + 1) * 20; continue; }
      row += c.repeat(count || 1); count = 0;
      if (row.length >= width) { if (row.length > width) throw new Error('row overflow'); finish(''); }
    }
    if (rows.length * Number(rowBytes) !== Number(total)) throw new Error(`expected ${Number(total) / Number(rowBytes)} rows, got ${rows.length}`);
    return { rowBytes: Number(rowBytes), rows };
  });
}
export const blackDots = label => label.rows.reduce((sum, row) => sum + [...row].reduce((n, h) => n + [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][parseInt(h, 16)], 0), 0);
