import { typedCandidates, typedDigits, typedTour, looseTyped } from './sticker.js';
// The guest of tour number `tour` to count for a meal when a card is checked by its tour number: staying on `date` in an
// active stay, within its PAX, holding a current card and not yet admitted for `meal`. The highest card number goes
// first. CROSS JOIN keeps SQLite starting from people_sticker, so it reads only the people of that tour number instead
// of every stay that has arrived. Columns: person, card, hash.
export const freeGuestSql = (tour, date, meal) => `SELECT p2.id AS person_id,c2.id AS card_id,c2.token_hash FROM people p2
 CROSS JOIN tours t2 ON t2.id=p2.tour_id CROSS JOIN cards c2 ON c2.person_id=p2.id AND c2.revoked_at IS NULL
 WHERE p2.sticker_tour=${tour} AND t2.active=1 AND t2.arrival<=${date} AND t2.departure>=${date} AND p2.person_no<=t2.pax
 AND NOT EXISTS(SELECT 1 FROM admissions a2 WHERE a2.person_id=p2.id AND a2.date=${date} AND a2.meal=${meal})
 ORDER BY p2.sticker_no DESC LIMIT 1`;
const SERVED = 'EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5)';
// A meal taken by tour number moves to another guest of the tour who has not eaten (trigger admit_logged_scan), so
// the guest's own card still goes green. When every other guest has eaten, the card is a duplicate.
const MOVABLE = `(EXISTS(SELECT 1 FROM admissions a WHERE a.person_id=p.id AND a.date=?2 AND a.meal=?5 AND a.by_tour=1)
 AND EXISTS(${freeGuestSql('p.sticker_tour', '?2', '?5')}))`;
// Some stay with this tour number is staying today, so a tour number with no guest left has simply been fully served.
const TOUR_STAYING = 'EXISTS(SELECT 1 FROM people p3 CROSS JOIN tours t3 ON t3.id=p3.tour_id WHERE p3.sticker_tour=?11 AND t3.active=1 AND t3.arrival<=?2 AND t3.departure>=?2)';
// A tour is in Karbala on a date when some record besides the card's own stay says so: another active stay under the
// same tour ID covers the date, or NKERP (read every ten minutes, src/nkerp.js) has a Karbala visit of the tour that
// covers it. A card whose own stay is switched off, has not started or has ended is still let in then: the guest is a
// guest of a tour that is here, and only the app's dates for that stay are wrong (a Sheet sync that has stopped, a
// card printed for the tour's other visit, a stay added by hand with the wrong dates). key is the tour ID expression;
// date the service date. Evaluated only for a card that would otherwise be turned away for its dates.
export const tourHereSql = (key, date) => `(EXISTS(SELECT 1 FROM tours t4 WHERE (t4.tour_id=${key} OR t4.shared_tour_id=${key})
 AND t4.active=1 AND t4.arrival<=${date} AND t4.departure>=${date})
 OR EXISTS(SELECT 1 FROM settings s4,json_each(s4.value,'$.visits') v4 WHERE s4.key='nkerp'
 AND ${key} IN (json_extract(v4.value,'$[0]'),substr(json_extract(v4.value,'$[0]'),4))
 AND substr(json_extract(v4.value,'$[1]'),1,10)<=${date} AND json_extract(v4.value,'$[2]')>=${date}))`;
const HERE = tourHereSql('COALESCE(t.tour_id,t.shared_tour_id)', '?2');
// Executed as a single statement; admission and daily counters commit with the log.
// ?6 marks a scan checked on a phone without a connection and sent later; ?7 says that phone showed red,
// so the guest was turned away and no meal is recorded even if the card was otherwise valid.
// Breakfast is open to everyone and scanned only to count who came: every card is let in and counted once per
// person, whatever its dates or status, and a repeat or an unlisted code is let in without being counted again.
// ?8 is the scanner tab that checked the card: 'men', 'women' or NULL (a phone on an older version).
// ?9 is the number typed at the gate (NULL for a QR scan); ?10 is why a typed number found no card
// ('unknown_number' or 'ambiguous_number', see sticker.js), NULL for a QR scan.
// ?11 is a tour number typed for a card with no number (NULL otherwise): the card checked is that of a guest of the
// tour who has not had this meal (freeGuestSql), chosen in this same statement so two gates never pick the same guest.
// When none is left the scan is red with tour_full (green breakfast_repeat at breakfast). by_tour marks the scan when
// the tour is staying; a tour number nobody is staying under is simply an unknown number.
export const SCAN_SQL = `INSERT INTO scan_logs(request_key,card_id,person_id,tour_id,person_no,date,meal,reason,scanned_at,offline,gate,typed_code,by_tour)
 SELECT ?1,c.id,p.id,t.id,p.person_no,?2,?5,
 CASE WHEN c.id IS NULL THEN CASE WHEN ?11 IS NOT NULL AND ${TOUR_STAYING} THEN CASE WHEN ?5='breakfast' THEN 'breakfast_repeat' ELSE 'tour_full' END
  WHEN ?5='breakfast' THEN 'breakfast_unlisted' ELSE COALESCE(?10,'unknown_card') END
 WHEN ?5='breakfast' THEN CASE WHEN ${SERVED} AND NOT ${MOVABLE} THEN 'breakfast_repeat'
  WHEN ?7=1 THEN 'offline_declined' ELSE 'admitted' END
 WHEN (t.active=0 OR ?2<t.arrival OR ?2>t.departure) AND NOT ${HERE}
  THEN CASE WHEN t.active=0 THEN 'inactive_tour' WHEN ?2<t.arrival THEN 'before_arrival' ELSE 'after_departure' END
 WHEN c.revoked_at IS NOT NULL THEN 'replaced_card'
 WHEN p.person_no>t.pax THEN 'over_capacity' WHEN ?5 IS NULL THEN 'outside_meal_time'
 WHEN ${SERVED} AND NOT ${MOVABLE} THEN 'already_scanned'
 WHEN ?7=1 THEN 'offline_declined' ELSE 'admitted' END,?3,?6,?8,?9,CASE WHEN ?11 IS NOT NULL AND (c.id IS NOT NULL OR ${TOUR_STAYING}) THEN 1 END
 FROM (SELECT 1) LEFT JOIN cards c ON c.token_hash=CASE WHEN ?11 IS NULL THEN ?4 ELSE (SELECT token_hash FROM (${freeGuestSql('?11', '?2', '?5')})) END
 LEFT JOIN people p ON p.id=c.person_id LEFT JOIN tours t ON t.id=p.tour_id
 WHERE true ON CONFLICT(request_key) DO NOTHING RETURNING *`;
// A duplicate scan shows when that meal was first served.
export const FIRST_ADMISSION_SQL = 'SELECT scanned_at FROM admissions WHERE person_id=? AND date=? AND meal=?';
export const REPEAT_REASONS = ['already_scanned', 'breakfast_repeat'];
// Reasons the gate shows green; only 'admitted' records a meal.
export const GREEN_REASONS = ['admitted', 'breakfast_repeat', 'breakfast_unlisted'];
export const SCAN_REASONS = { admitted: 'Welcome — meal allowed', before_arrival: 'Arrival date has not started', after_departure: 'Stay has ended',
  replaced_card: 'This card was replaced', unknown_card: 'Card not recognised', over_capacity: 'Person exceeds the current tour PAX', inactive_tour: 'Tour is no longer active in the source sheet',
  outside_meal_time: 'Meal service is closed.', already_scanned: 'Already admitted for this meal today',
  tour_full: 'Every guest of this tour has already had this meal',
  offline_declined: 'Turned away by a phone that was offline',
  unknown_number: 'No card or tour has this number. Check the number, or scan the QR code', ambiguous_number: 'This number matches more than one guest. Scan the QR code',
  breakfast_repeat: 'Welcome — already counted for breakfast', breakfast_unlisted: 'Welcome — breakfast is open to all. Card not on the list, so not counted' };
// The scanner has a Men's and a Women's tab. A phone on an older version sends no gate, which stays NULL.
export const GATES = ['men', 'women'];
export function scanGate(body) {
  if (body.gate === undefined || body.gate === null || body.gate === '') return null;
  if (!GATES.includes(body.gate)) throw Object.assign(new Error('Unknown scanner.'), { status: 400 });
  return body.gate;
}
// A scan is a QR code read by the camera or a USB scanner ({ code }), or a number typed at the gate ({ number }): the
// card number under the QR, or only the tour number for a card that has no number (see typedTour in sticker.js).
export function scanEntry(body) {
  const bad = message => Object.assign(new Error(message), { status: 400 });
  if (body.number !== undefined && body.number !== null) {
    if (typeof body.number !== 'string' || body.number.length > 30 || (!typedCandidates(body.number).length && !typedTour(body.number) && !looseTyped(body.number).some(v => typedCandidates(v).length))) throw bad('Enter the card number printed under the QR code, such as 015253, or the tour number if the card has none.');
    const typed = typedDigits(body.number);
    return { code: '', typed, cardNumber: typedCandidates(typed).length > 0, tour: typedTour(typed) };
  }
  if (typeof body.code !== 'string' || body.code.length > 300) throw bad('Invalid QR code.');
  return { code: body.code, typed: null, cardNumber: false, tour: null };
}
// A typed number is a card number when a card holds it; otherwise, if it can be a tour number, it is checked as one.
// found: the result of typedCard (or null when the value cannot be a card number). Returns the ?11 parameter.
export const tourParam = (entry, found) => entry.tour && (!found || found.miss === 'unknown_number') ? entry.tour : null;
// Offline scans are accepted for up to two days, so a phone that lost its connection overnight can still send them.
export const OFFLINE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
export function offlineTime(body, now) {
  if (body.offlineAt === undefined) return null;
  const at = typeof body.offlineAt === 'string' && body.offlineAt.length <= 40 ? new Date(body.offlineAt) : null;
  if (!at || Number.isNaN(at.getTime()) || at > new Date(now.getTime() + 5 * 60 * 1000) || at < new Date(now.getTime() - OFFLINE_WINDOW_MS)) throw Object.assign(new Error('This offline scan is too old or has an invalid time.'), { status: 400 });
  return at;
}
