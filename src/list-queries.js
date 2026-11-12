import { listOrder, tourStatus, safariStatus } from './tour-list.js';
import { GREEN_REASONS, GATES } from './scan-query.js';
import { tourIdSql } from './rules.js';
const TOUR_ID = tourIdSql('t.');
const green = `s.reason IN (${GREEN_REASONS.map(r => `'${r}'`).join(',')})`;
// Optional date filters must stay indexable: WHERE arrival=? rather than (?='' OR arrival=?).
export function tourList({ arrival = '', q = '', sort = '', status = '' } = {}) {
  const params = [], where = ['t.active=1', tourStatus(status)];
  if (arrival) { where.push('t.arrival=?'); params.push(arrival); }
  if (q) { where.push(`(instr(lower(${TOUR_ID}),?)>0 OR instr(lower(t.office),?)>0 OR instr(lower(t.its),?)>0)`); params.push(q,q,q); }
  return { sql: `SELECT x.*,(SELECT printer_status FROM batches WHERE id=x.batch_id) AS batch_status FROM
    (SELECT t.id,${TOUR_ID} AS tour_id,t.its,t.office,t.arrival,t.departure,t.pax,t.source,t.source_key,t.created_at,t.active,
      (SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued,
      (SELECT b.id FROM people p CROSS JOIN cards c ON c.person_id=p.id JOIN batches b ON b.id=c.batch_id
        WHERE p.tour_id=t.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1) AS batch_id
      FROM tours t WHERE ${where.join(' AND ')} ORDER BY ${listOrder(sort,'t.',TOUR_ID)} LIMIT 1000) x
    ORDER BY ${listOrder(sort,'x.')}`, params };
}
export function safariList({ arrival = '', q = '', sort = '', status = '' } = {}) {
  const params = [], where = [safariStatus(status)];
  if (arrival) { where.push('s.arrival=?'); params.push(arrival); }
  if (q) { where.push('(instr(lower(s.tour_id),?)>0 OR instr(lower(s.office),?)>0 OR instr(lower(s.its),?)>0)'); params.push(q,q,q); }
  return { sql: `SELECT x.*,(SELECT printer_status FROM batches WHERE id=x.batch_id) AS batch_status FROM
    (SELECT s.*,(SELECT b.id FROM safari_prints sp JOIN batches b ON b.id=sp.batch_id
      WHERE sp.safari_id=s.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1) AS batch_id
      FROM safaris s WHERE ${where.join(' AND ')} ORDER BY ${listOrder(sort,'s.')},s.created_at LIMIT 1000) x
    ORDER BY ${listOrder(sort,'x.')},x.created_at`, params };
}
export function scanLogQuery({ date = '', tour = '', office = '', status = '', gate = '' } = {}) {
  const params = [], where = [];
  if (date) { where.push('s.date=?'); params.push(date); }
  if (tour) { where.push(`instr(lower(${TOUR_ID}),?)>0`); params.push(tour); }
  if (office) { where.push('instr(lower(t.office),?)>0'); params.push(office); }
  if (status === 'green') where.push(green);
  if (status === 'red') where.push(`NOT ${green}`);
  if (GATES.includes(gate)) { where.push('s.gate=?'); params.push(gate); }
  return { sql: `SELECT s.*,${TOUR_ID} AS display_tour,t.office FROM scan_logs s LEFT JOIN tours t ON t.id=s.tour_id
    ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 1000`, params };
}
// Scan log totals for one date, per scanner (Men's, Women's, or none recorded for older scans).
// Admitted counts each person once per meal, like Daily summary, plus breakfast codes not on the card list
// (let in, but they belong to no person); a repeat breakfast scan of the same card is not counted again.
// Declined counts every red scan. Only the chosen date is read (indexed), narrowed by the tour ID and office filters.
const counted = "s.reason IN ('admitted','breakfast_unlisted')";
export function gateCountQuery({ date = '', tour = '', office = '' } = {}) {
  const params = [date], where = ['s.date=?'];
  if (tour) { where.push(`instr(lower(${TOUR_ID}),?)>0`); params.push(tour); }
  if (office) { where.push('instr(lower(t.office),?)>0'); params.push(office); }
  return { sql: `SELECT COALESCE(s.gate,'') AS gate,
    COALESCE(SUM(${counted} AND s.meal='breakfast'),0) AS breakfast,COALESCE(SUM(${counted} AND s.meal='lunch'),0) AS lunch,
    COALESCE(SUM(${counted} AND s.meal='dinner'),0) AS dinner,COALESCE(SUM(${counted}),0) AS admitted,
    COALESCE(SUM(NOT ${green}),0) AS declined,COUNT(*) AS scans
    FROM scan_logs s LEFT JOIN tours t ON t.id=s.tour_id WHERE ${where.join(' AND ')} GROUP BY COALESCE(s.gate,'')`, params };
}
// Shapes gateCountQuery rows into { men, women, none }, each always present.
export function gateCounts(rows) {
  const empty = () => ({ breakfast: 0, lunch: 0, dinner: 0, admitted: 0, declined: 0, scans: 0 });
  const out = { men: empty(), women: empty(), none: empty() };
  for (const { gate, ...counts } of rows) Object.assign(out[GATES.includes(gate) ? gate : 'none'], Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])));
  return out;
}
export const BATCH_LIST_SQL = `SELECT b.id,b.created_at,b.kind,b.printer_status,b.pdf IS NOT NULL AS pdf_ready,
  (SELECT COUNT(*) FROM cards c WHERE c.batch_id=b.id)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS count,
  (SELECT COUNT(*) FROM cards c WHERE c.batch_id=b.id AND c.revoked_at IS NULL)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS active_count
  FROM batches b ORDER BY b.created_at DESC,b.rowid DESC LIMIT 200`;
