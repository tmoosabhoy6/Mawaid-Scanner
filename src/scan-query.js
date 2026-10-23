// Executed as a single statement; admission and daily counters commit with the log.
// ?6 marks a scan checked on a phone without a connection and sent later; ?7 says that phone showed red,
// so the guest was turned away and no meal is recorded even if the card was otherwise valid.
// A day after departure is allowed when the tour is extended for it: a whole day, or lunch only.
const extended = meal => `EXISTS(SELECT 1 FROM tour_extensions e WHERE e.tour_id=t.id AND e.date=?2 AND e.removed_at IS NULL${meal ? " AND (e.meals='day' OR e.meals=?5)" : ''})`;
export const SCAN_SQL = `INSERT INTO scan_logs(request_key,card_id,person_id,tour_id,person_no,date,meal,reason,scanned_at,offline)
 SELECT ?1,c.id,p.id,t.id,p.person_no,?2,?5,
 CASE WHEN c.id IS NULL THEN 'unknown_card' WHEN t.active=0 THEN 'inactive_tour' WHEN c.revoked_at IS NOT NULL THEN 'replaced_card'
 WHEN ?2<t.arrival THEN 'before_arrival' WHEN ?2>t.departure AND NOT ${extended(false)} THEN 'after_departure'
 WHEN p.person_no>t.pax THEN 'over_capacity' WHEN ?5 IS NULL THEN 'outside_meal_time'
 WHEN ?2>t.departure AND NOT ${extended(true)} THEN 'extension_other_meal'
 WHEN EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5) THEN 'already_scanned'
 WHEN ?7=1 THEN 'offline_declined' ELSE 'admitted' END,?3,?6
 FROM (SELECT 1) LEFT JOIN cards c ON c.token_hash=?4 LEFT JOIN people p ON p.id=c.person_id LEFT JOIN tours t ON t.id=p.tour_id
 WHERE true ON CONFLICT(request_key) DO NOTHING RETURNING *`;
// A duplicate scan shows when that meal was first served.
export const FIRST_ADMISSION_SQL = 'SELECT scanned_at FROM admissions WHERE person_id=? AND date=? AND meal=?';
export const SCAN_REASONS = { admitted: 'Welcome — meal allowed', before_arrival: 'Arrival date has not started', after_departure: 'Stay has ended. The office can extend it on the Tours page.',
  replaced_card: 'This card was replaced', unknown_card: 'Card not recognised', over_capacity: 'Person exceeds the current tour PAX', inactive_tour: 'Tour is no longer active in the source sheet',
  outside_meal_time: 'Meal service is closed.', already_scanned: 'Already admitted for this meal today',
  extension_other_meal: 'Stay extended for lunch only today', offline_declined: 'Turned away by a phone that was offline' };
// Offline scans are accepted for up to two days, so a phone that lost its connection overnight can still send them.
export const OFFLINE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export function offlineTime(body, now) {
  if (body.offlineAt === undefined) return null;
  const at = typeof body.offlineAt === 'string' && body.offlineAt.length <= 40 ? new Date(body.offlineAt) : null;
  if (!at || Number.isNaN(at.getTime()) || at > new Date(now.getTime() + 5 * 60 * 1000) || at < new Date(now.getTime() - OFFLINE_WINDOW_MS)) throw Object.assign(new Error('This offline scan is too old or has an invalid time.'), { status: 400 });
  return at;
}
