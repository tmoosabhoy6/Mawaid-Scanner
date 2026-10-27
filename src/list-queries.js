import { listOrder, tourStatus, safariStatus } from './tour-list.js';
import { GREEN_REASONS } from './scan-query.js';
const green = `s.reason IN (${GREEN_REASONS.map(r => `'${r}'`).join(',')})`;
// Optional date filters must stay indexable: WHERE arrival=? rather than (?='' OR arrival=?).
export function tourList({ arrival = '', q = '', sort = '', status = '' } = {}) {
  const params = [], where = ['t.active=1', tourStatus(status)];
  if (arrival) { where.push('t.arrival=?'); params.push(arrival); }
  if (q) { where.push('(instr(lower(t.tour_id),?)>0 OR instr(lower(t.office),?)>0 OR instr(lower(t.its),?)>0)'); params.push(q,q,q); }
  return { sql: `SELECT x.*,(SELECT printer_status FROM batches WHERE id=x.batch_id) AS batch_status FROM
    (SELECT t.*,(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued,
      (SELECT group_concat(e.date||' '||e.meals) FROM tour_extensions e WHERE e.tour_id=t.id AND e.removed_at IS NULL) AS extensions,
      (SELECT b.id FROM people p CROSS JOIN cards c ON c.person_id=p.id JOIN batches b ON b.id=c.batch_id
        WHERE p.tour_id=t.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1) AS batch_id
      FROM tours t WHERE ${where.join(' AND ')} ORDER BY ${listOrder(sort,'t.')} LIMIT 1000) x
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
export function scanLogQuery({ date = '', tour = '', office = '', status = '' } = {}) {
  const params = [], where = [];
  if (date) { where.push('s.date=?'); params.push(date); }
  if (tour) { where.push('instr(lower(t.tour_id),?)>0'); params.push(tour); }
  if (office) { where.push('instr(lower(t.office),?)>0'); params.push(office); }
  if (status === 'green') where.push(green);
  if (status === 'red') where.push(`NOT ${green}`);
  return { sql: `SELECT s.*,t.tour_id AS display_tour,t.office FROM scan_logs s LEFT JOIN tours t ON t.id=s.tour_id
    ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT 1000`, params };
}
export const BATCH_LIST_SQL = `SELECT b.id,b.created_at,b.kind,b.printer_status,b.pdf IS NOT NULL AS pdf_ready,
  (SELECT COUNT(*) FROM cards c WHERE c.batch_id=b.id)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS count,
  (SELECT COUNT(*) FROM cards c WHERE c.batch_id=b.id AND c.revoked_at IS NULL)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS active_count
  FROM batches b ORDER BY b.created_at DESC,b.rowid DESC LIMIT 200`;
