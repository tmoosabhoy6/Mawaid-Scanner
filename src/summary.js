// One indexed row per date, maintained in the same transaction as the scan log.
// Historical scans without a meal remain visible without inventing a meal assignment.
export const SUMMARY_SQL = `SELECT ?1 AS date,
  COALESCE(d.breakfast,0) AS breakfast,COALESCE(d.lunch,0) AS lunch,COALESCE(d.dinner,0) AS dinner,
  COALESCE(d.other,0) AS other,
  COALESCE(d.breakfast+d.lunch+d.dinner+d.other,0) AS scans
  FROM (SELECT 1) LEFT JOIN daily_scan_counts d ON d.date=?1`;
