// Executed as a single statement; admission and daily counters commit with the log.
// ?6 marks a scan checked on a phone without a connection and sent later; ?7 says that phone showed red,
// so the guest was turned away and no meal is recorded even if the card was otherwise valid.
// Breakfast is open to everyone and scanned only to count who came: every card is let in and counted once per
// person, whatever its dates or status, and a repeat or an unlisted code is let in without being counted again.
// ?8 is the scanner tab that checked the card: 'men', 'women' or NULL (a phone on an older version).
export const SCAN_SQL = `INSERT INTO scan_logs(request_key,card_id,person_id,tour_id,person_no,date,meal,reason,scanned_at,offline,gate)
 SELECT ?1,c.id,p.id,t.id,p.person_no,?2,?5,
 CASE WHEN c.id IS NULL THEN CASE WHEN ?5='breakfast' THEN 'breakfast_unlisted' ELSE 'unknown_card' END
 WHEN ?5='breakfast' THEN CASE WHEN EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5) THEN 'breakfast_repeat'
  WHEN ?7=1 THEN 'offline_declined' ELSE 'admitted' END
 WHEN t.active=0 THEN 'inactive_tour' WHEN c.revoked_at IS NOT NULL THEN 'replaced_card'
 WHEN ?2<t.arrival THEN 'before_arrival' WHEN ?2>t.departure THEN 'after_departure'
 WHEN p.person_no>t.pax THEN 'over_capacity' WHEN ?5 IS NULL THEN 'outside_meal_time'
 WHEN EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5) THEN 'already_scanned'
 WHEN ?7=1 THEN 'offline_declined' ELSE 'admitted' END,?3,?6,?8
 FROM (SELECT 1) LEFT JOIN cards c ON c.token_hash=?4 LEFT JOIN people p ON p.id=c.person_id LEFT JOIN tours t ON t.id=p.tour_id
 WHERE true ON CONFLICT(request_key) DO NOTHING RETURNING *`;
// A duplicate scan shows when that meal was first served.
export const FIRST_ADMISSION_SQL = 'SELECT scanned_at FROM admissions WHERE person_id=? AND date=? AND meal=?';
export const REPEAT_REASONS = ['already_scanned', 'breakfast_repeat'];
// Reasons the gate shows green; only 'admitted' records a meal.
export const GREEN_REASONS = ['admitted', 'breakfast_repeat', 'breakfast_unlisted'];
export const SCAN_REASONS = { admitted: 'Welcome — meal allowed', before_arrival: 'Arrival date has not started', after_departure: 'Stay has ended',
  replaced_card: 'This card was replaced', unknown_card: 'Card not recognised', over_capacity: 'Person exceeds the current tour PAX', inactive_tour: 'Tour is no longer active in the source sheet',
  outside_meal_time: 'Meal service is closed.', already_scanned: 'Already admitted for this meal today',
  offline_declined: 'Turned away by a phone that was offline',
  breakfast_repeat: 'Welcome — already counted for breakfast', breakfast_unlisted: 'Welcome — breakfast is open to all. Card not on the list, so not counted' };
// The scanner has a Men's and a Women's tab. A phone on an older version sends no gate, which stays NULL.
export const GATES = ['men', 'women'];
export function scanGate(body) {
  if (body.gate === undefined || body.gate === null || body.gate === '') return null;
  if (!GATES.includes(body.gate)) throw Object.assign(new Error('Unknown scanner.'), { status: 400 });
  return body.gate;
}
// Offline scans are accepted for up to two days, so a phone that lost its connection overnight can still send them.
export const OFFLINE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export function offlineTime(body, now) {
  if (body.offlineAt === undefined) return null;
  const at = typeof body.offlineAt === 'string' && body.offlineAt.length <= 40 ? new Date(body.offlineAt) : null;
  if (!at || Number.isNaN(at.getTime()) || at > new Date(now.getTime() + 5 * 60 * 1000) || at < new Date(now.getTime() - OFFLINE_WINDOW_MS)) throw Object.assign(new Error('This offline scan is too old or has an invalid time.'), { status: 400 });
  return at;
}
