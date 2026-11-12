import { tourIdSql } from './rules.js';
import { GATES } from './scan-query.js';
const TOUR_ID = tourIdSql('t.');
// One indexed row per date, maintained in the same transaction as the scan log.
// Historical scans without a meal remain visible without inventing a meal assignment.
export const SUMMARY_SQL = `SELECT ?1 AS date,
  COALESCE(d.breakfast,0) AS breakfast,COALESCE(d.lunch,0) AS lunch,COALESCE(d.dinner,0) AS dinner,
  COALESCE(d.other,0) AS other,
  COALESCE(d.breakfast+d.lunch+d.dinner+d.other,0) AS scans
  FROM (SELECT 1) LEFT JOIN daily_scan_counts d ON d.date=?1`;
// The same counts split by scanner (Men's, Women's, or none recorded for scans made before the split).
// Every 'admitted' scan records exactly one meal served, so these add up to SUMMARY_SQL. Reads the date's scans (indexed).
const MEAL_IDS = "('breakfast','lunch','dinner')";
export const GATE_SUMMARY_SQL = `SELECT COALESCE(gate,'') AS gate,
  SUM(meal='breakfast') AS breakfast,SUM(meal='lunch') AS lunch,SUM(meal='dinner') AS dinner,
  SUM(meal IS NULL OR meal NOT IN ${MEAL_IDS}) AS other,COUNT(*) AS scans
  FROM scan_logs WHERE date=?1 AND reason='admitted' GROUP BY COALESCE(gate,'')`;
// Shapes GATE_SUMMARY_SQL rows into { men, women, none }, each always present.
export function gateSummary(rows) {
  const empty = () => ({ breakfast: 0, lunch: 0, dinner: 0, other: 0, scans: 0 });
  const out = { men: empty(), women: empty(), none: empty() };
  for (const { gate, ...counts } of rows) {
    const target = out[GATES.includes(gate) ? gate : 'none'];
    for (const key of Object.keys(target)) target[key] += Number(counts[key]) || 0;
  }
  return out;
}
// Daily summary for a date, with the men's / women's split.
export const summaryWithGates = (totals, rows) => ({ ...totals, gates: gateSummary(rows) });
// Tour-wise report: every tour staying on the date or served on it, with meals served per tour.
// For one scanner, meals come from that scanner's admitted scans; the same tours are listed either way.
const tourReport = served => `WITH served AS (${served})
  SELECT t.id,${TOUR_ID} AS tour_id,t.office,t.pax,t.arrival,t.departure,
    COALESCE(s.breakfast,0) AS breakfast,COALESCE(s.lunch,0) AS lunch,COALESCE(s.dinner,0) AS dinner
  FROM tours t LEFT JOIN served s ON s.tour=t.id
  WHERE (t.active=1 AND t.arrival<=?1 AND t.departure>=?1) OR s.tour IS NOT NULL
  ORDER BY ${TOUR_ID} IS NULL,${TOUR_ID},t.office LIMIT 1000`;
export const TOUR_REPORT_SQL = tourReport(`SELECT p.tour_id AS tour,SUM(a.meal='breakfast') AS breakfast,SUM(a.meal='lunch') AS lunch,SUM(a.meal='dinner') AS dinner
    FROM admissions a JOIN people p ON p.id=a.person_id WHERE a.date=?1 GROUP BY p.tour_id`);
// ?2 is the scanner: 'men' or 'women'.
export const GATE_TOUR_REPORT_SQL = tourReport(`SELECT s.tour_id AS tour,SUM(s.meal='breakfast') AS breakfast,SUM(s.meal='lunch') AS lunch,SUM(s.meal='dinner') AS dinner
    FROM scan_logs s WHERE s.date=?1 AND s.reason='admitted' AND s.gate=?2 AND s.tour_id IS NOT NULL GROUP BY s.tour_id`);
// The tour report query and parameters for a date and an optional scanner ('' or anything else means all).
export const tourReportQuery = (date, gate) => GATES.includes(gate)
  ? { sql: GATE_TOUR_REPORT_SQL, params: [date, gate] } : { sql: TOUR_REPORT_SQL, params: [date] };
