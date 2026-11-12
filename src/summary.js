import { tourIdSql } from './rules.js';
const TOUR_ID = tourIdSql('t.');
// One indexed row per date, maintained in the same transaction as the scan log.
// Historical scans without a meal remain visible without inventing a meal assignment.
export const SUMMARY_SQL = `SELECT ?1 AS date,
  COALESCE(d.breakfast,0) AS breakfast,COALESCE(d.lunch,0) AS lunch,COALESCE(d.dinner,0) AS dinner,
  COALESCE(d.other,0) AS other,
  COALESCE(d.breakfast+d.lunch+d.dinner+d.other,0) AS scans
  FROM (SELECT 1) LEFT JOIN daily_scan_counts d ON d.date=?1`;
// Tour-wise report: every tour staying on the date or served on it, with meals served per tour.
export const TOUR_REPORT_SQL = `WITH served AS (SELECT p.tour_id AS tour,SUM(a.meal='breakfast') AS breakfast,SUM(a.meal='lunch') AS lunch,SUM(a.meal='dinner') AS dinner
    FROM admissions a JOIN people p ON p.id=a.person_id WHERE a.date=?1 GROUP BY p.tour_id)
  SELECT t.id,${TOUR_ID} AS tour_id,t.office,t.pax,t.arrival,t.departure,
    COALESCE(s.breakfast,0) AS breakfast,COALESCE(s.lunch,0) AS lunch,COALESCE(s.dinner,0) AS dinner
  FROM tours t LEFT JOIN served s ON s.tour=t.id
  WHERE (t.active=1 AND t.arrival<=?1 AND t.departure>=?1) OR s.tour IS NOT NULL
  ORDER BY ${TOUR_ID} IS NULL,${TOUR_ID},t.office LIMIT 1000`;
