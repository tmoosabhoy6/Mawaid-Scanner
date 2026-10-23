// Archive export and storage clean-up, shared by the Node server and the Cloudflare Worker.
// Parameters: ?1 = clear records dated before this Karbala date, ?2 = rowid cursor, ?3 = page size.
import { validDate } from './rules.js';
export const ARCHIVE_PAGE = 1000, CLEAR_ROWS = 1000, CLEAR_PDFS = 20;
// Cloudflare's free plan allows 100,000 rows written per day (UTC), counting index rows and deletes.
// Clean-up stops at 40,000 so scanning and printing always keep most of the daily allowance.
export const CLEANUP_WRITE_BUDGET = 40_000, CLEANUP_CHUNK_WRITES = 8_000;
export const ARCHIVE_DATASETS = {
  scans: `SELECT s.id AS cursor,s.scanned_at,s.date,s.meal,t.tour_id,t.office,s.person_no,s.reason FROM scan_logs s LEFT JOIN tours t ON t.id=s.tour_id
    WHERE s.date<?1 AND s.id>?2 ORDER BY s.id LIMIT ?3`,
  meals: `SELECT a.rowid AS cursor,a.date,a.meal,a.scanned_at,t.id AS tour_key,t.tour_id,t.office,p.person_no FROM admissions a JOIN people p ON p.id=a.person_id JOIN tours t ON t.id=p.tour_id
    WHERE a.date<?1 AND a.rowid>?2 ORDER BY a.rowid LIMIT ?3`,
  tours: `SELECT t.rowid AS cursor,t.id AS tour_key,t.tour_id,t.its,t.office,t.arrival,t.departure,t.pax,t.source,t.active,t.created_at,(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued
    FROM tours t WHERE ?1<>'' AND t.rowid>?2 ORDER BY t.rowid LIMIT ?3`,
  cards: `SELECT c.rowid AS cursor,t.tour_id,t.office,t.arrival,p.person_no,c.created_at,c.revoked_at,c.batch_id FROM cards c JOIN people p ON p.id=c.person_id JOIN tours t ON t.id=p.tour_id
    WHERE ?1<>'' AND c.rowid>?2 ORDER BY c.rowid LIMIT ?3`,
  prints: `SELECT b.rowid AS cursor,b.id AS batch_id,b.created_at,b.kind,b.printer_status,b.pdf IS NOT NULL AS pdf_saved,(SELECT COUNT(*) FROM cards c WHERE c.batch_id=b.id)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS labels
    FROM batches b WHERE ?1<>'' AND b.rowid>?2 ORDER BY b.rowid LIMIT ?3`,
};
// A label PDF can be cleared once every stay printed in it has departed before the cut-off date.
// An undated Safari card counts as departing on the day its stickers were printed.
const finishedBatch = `NOT EXISTS(SELECT 1 FROM cards c JOIN people p ON p.id=c.person_id JOIN tours t ON t.id=p.tour_id WHERE c.batch_id=b.id AND t.departure>=?1)
  AND NOT EXISTS(SELECT 1 FROM safari_prints sp JOIN safaris s ON s.id=sp.safari_id WHERE sp.batch_id=b.id AND COALESCE(s.departure,substr(b.created_at,1,10))>=?1)`;
export function archiveSql(envelope) {
  const stored = envelope ? '(b.pdf IS NOT NULL OR b.envelope IS NOT NULL)' : 'b.pdf IS NOT NULL';
  return {
    counts: `SELECT (SELECT COUNT(*) FROM scan_logs WHERE date<?1) AS scans,(SELECT COUNT(*) FROM admissions WHERE date<?1) AS meals,
      (SELECT COUNT(*) FROM batches b WHERE ${stored} AND ${finishedBatch}) AS pdfs`,
    clearScans: `DELETE FROM scan_logs WHERE id IN (SELECT id FROM scan_logs WHERE date<?1 ORDER BY id LIMIT ${CLEAR_ROWS})${envelope ? ' RETURNING id' : ''}`,
    clearMeals: `DELETE FROM admissions WHERE rowid IN (SELECT rowid FROM admissions WHERE date<?1 LIMIT ${CLEAR_ROWS})`,
    clearPdfs: `UPDATE batches SET pdf=NULL,${envelope ? 'envelope=NULL,' : ''}printer_status='pdf_cleared' WHERE rowid IN (SELECT b.rowid FROM batches b WHERE ${stored} AND ${finishedBatch} LIMIT ${CLEAR_PDFS})`,
  };
}
// Records from today (Karbala) onward are never cleared: today's admissions stop a second meal.
export function archiveCutoff(value, today) {
  if (!validDate(value)) throw Object.assign(new Error('Choose a valid date.'), { status: 400 });
  if (value > today) throw Object.assign(new Error('Choose today or an earlier date. Today’s meals and future stays are never cleared.'), { status: 400 });
  return value;
}
export function archivePage(url) {
  const after = Number(url.searchParams.get('after') || 0), limit = Number(url.searchParams.get('limit') || ARCHIVE_PAGE);
  if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid archive cursor.'), { status: 400 });
  return { after, limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, ARCHIVE_PAGE) : ARCHIVE_PAGE };
}
export const cleanupDay = now => now.toISOString().slice(0, 10);
