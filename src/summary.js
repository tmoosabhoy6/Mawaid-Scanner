// Daily summary shared by the Node server and the Cloudflare Worker: green scans per tour on one Karbala date (?1).
export const SUMMARY_SQL = `SELECT t.id,t.tour_id,t.office,t.pax,COUNT(s.id) AS scans,COUNT(DISTINCT s.person_no) AS people
  FROM tours t LEFT JOIN scan_logs s ON s.tour_id=t.id AND s.date=?1 AND s.reason='admitted'
  WHERE t.active=1 AND t.arrival<=?1 AND t.departure>=?1 GROUP BY t.id ORDER BY t.tour_id`;
