// Executed as a single statement; admission and daily counters commit with the log.
export const SCAN_SQL = `INSERT INTO scan_logs(request_key,card_id,person_id,tour_id,person_no,date,meal,reason,scanned_at)
 SELECT ?1,c.id,p.id,t.id,p.person_no,?2,?5,
 CASE WHEN c.id IS NULL THEN 'unknown_card' WHEN t.active=0 THEN 'inactive_tour' WHEN c.revoked_at IS NOT NULL THEN 'replaced_card'
 WHEN ?2<t.arrival THEN 'before_arrival' WHEN ?2>t.departure THEN 'after_departure'
 WHEN p.person_no>t.pax THEN 'over_capacity' WHEN ?5 IS NULL THEN 'outside_meal_time'
 WHEN EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5) THEN 'already_scanned' ELSE 'admitted' END,?3
 FROM (SELECT 1) LEFT JOIN cards c ON c.token_hash=?4 LEFT JOIN people p ON p.id=c.person_id LEFT JOIN tours t ON t.id=p.tour_id
 WHERE true ON CONFLICT(request_key) DO NOTHING RETURNING *`;
