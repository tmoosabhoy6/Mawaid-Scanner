// Every meal card prints a card number under its QR code, so gate staff can type it when the QR will not scan:
// the guest's sticker number (two digits, more only past 99) followed by the tour number, with no separator.
// Person 37 of tour 26/5253 prints 375253; person 1 prints 015253.
//
// The sticker number is chosen when the card is printed and stored with the person (people.sticker_no and
// people.sticker_tour), so a printed number never changes afterwards. Tour IDs repeat (a tour returns the next month)
// and Add tour can add a second stay under the same tour ID while the first is still staying, so the number is unique
// among people whose stays share the tour number and overlap in dates: each stay continues after the highest number
// already printed in any overlapping stay. Trigger validate_sticker_no (migration 0008) refuses a duplicate, so two
// computers printing for the same tour at the same moment cannot both print the same number.

// The tour number printed after the sticker number: the digits after the year ("26/5253" → "5253"), or a tour ID
// that is only digits (tours added by hand before the year was required). Other tour IDs print no card number.
export function stickerTour(tourId) {
  const match = /^(?:\d{2}\/)?(\d{1,6})$/.exec(String(tourId ?? '').trim());
  return match ? match[1] : null;
}
export const stickerCode = (no, tour) => no && tour ? `${String(no).padStart(2, '0')}${tour}` : '';
// Staff may type spaces or a dash; anything else is not a card number.
export const typedDigits = value => String(value ?? '').replace(/[\s-]/g, '');
export const TYPED_FORMAT = /^\d{3,12}$/;
// The ways a typed number can split into a sticker number and a tour number. Two digits always; three or four only
// when the sticker number really has that many digits (100 and above), so 015253 never reads as sticker 15.
export function typedCandidates(value) {
  const digits = typedDigits(value);
  if (!TYPED_FORMAT.test(digits)) return [];
  const out = [];
  for (let width = 2; width <= 4 && width < digits.length; width++) {
    const no = Number(digits.slice(0, width));
    if (no >= 1 && (width === 2 || no >= 10 ** (width - 1))) out.push({ no, tour: digits.slice(width) });
  }
  return out;
}
// A card with no number under its QR is checked by typing only its tour number, as printed on the card: "3382", or
// "26/3382" with the year. Returns the tour number ("3382"), or null when the value cannot be one. A value that is also
// a card number (such as 3382: guest 33 of tour 82) is tried as a card number first (see the scan in app.js).
export function typedTour(value) {
  const match = /^(?:\d{2}\/)?(\d{1,6})$/.exec(typedDigits(value));
  return match ? match[1] : null;
}
// The people a typed number could mean, with each one's current card (or, for a person whose card was replaced
// before replacing was removed, their latest). Params: three (tour, sticker number) pairs; unused pairs are NULL.
export const TYPED_SQL = `SELECT p.id AS person_id,t.arrival,t.departure,
  (SELECT c.token_hash FROM cards c WHERE c.person_id=p.id ORDER BY c.revoked_at IS NULL DESC,c.rowid DESC LIMIT 1) AS token_hash
  FROM people p JOIN tours t ON t.id=p.tour_id
  WHERE (p.sticker_tour=?1 AND p.sticker_no=?2) OR (p.sticker_tour=?3 AND p.sticker_no=?4) OR (p.sticker_tour=?5 AND p.sticker_no=?6)`;
export function typedParams(value) {
  const c = typedCandidates(value), params = [];
  for (let i = 0; i < 3; i++) params.push(c[i]?.tour ?? null, c[i]?.no ?? null);
  return params;
}
// Chooses the guest a typed number means on a date. Numbers repeat only between stays that do not overlap, so at most
// one stay holding the number covers the date. When none does, the nearest stay is used, so the gate shows that the
// stay has not started or has ended. Two stays covering the date (possible only if the Sheet later moved a stay's
// dates over another's) cannot be told apart: the gate is told to scan the QR instead.
// Rows: { arrival, departure, ... }. Returns { row } or { reason: 'unknown_number' | 'ambiguous_number' }.
export function chooseTyped(rows, date) {
  const usable = rows.filter(r => r.token_hash !== null && r.token_hash !== undefined);
  if (!usable.length) return { reason: 'unknown_number' };
  const current = usable.filter(r => r.arrival <= date && date <= r.departure);
  if (current.length > 1) return { reason: 'ambiguous_number' };
  if (current.length === 1) return { row: current[0] };
  const days = r => Math.abs(Date.parse(date < r.arrival ? r.arrival : r.departure) - Date.parse(date));
  const sorted = [...usable].sort((a, b) => days(a) - days(b));
  if (sorted.length > 1 && days(sorted[0]) === days(sorted[1])) return { reason: 'ambiguous_number' };
  return { row: sorted[0] };
}
// The highest sticker number already printed for each selected stay's tour number in any stay overlapping its dates.
// Param: JSON array of { id, tour }.
export const STICKER_BASE_SQL = `SELECT json_extract(j.value,'$.id') AS id,
  (SELECT COALESCE(MAX(p.sticker_no),0) FROM tours s JOIN tours o ON o.arrival<=s.departure AND o.departure>=s.arrival
    JOIN people p ON p.tour_id=o.id AND p.sticker_tour=json_extract(j.value,'$.tour') WHERE s.id=json_extract(j.value,'$.id')) AS base
  FROM json_each(?1) j`;
// Numbers the new cards of one print job. cards: in print order, each with tour_key, tour_id, arrival and departure.
// bases: Map of stay id → highest number already printed for it (from STICKER_BASE_SQL). Cards for overlapping stays
// of the same tour number in this job continue from one another.
export function assignStickers(cards, bases) {
  const given = [];
  for (const card of cards) {
    const tour = stickerTour(card.tour_id);
    if (!tour) { card.sticker_no = null; card.sticker_tour = null; continue; }
    const overlapping = given.filter(g => g.tour === tour && g.arrival <= card.departure && g.departure >= card.arrival);
    const no = Math.max(bases.get(card.tour_key) || 0, ...overlapping.map(g => g.no)) + 1;
    Object.assign(card, { sticker_no: no, sticker_tour: tour });
    given.push({ tour, no, arrival: card.arrival, departure: card.departure });
  }
  return cards;
}
// The card a typed number means on a date, from the rows of TYPED_SQL. Returns { hash } (the card's stored token hash,
// which the scan then checks exactly like a QR scan of that card) or { hash: '', miss } with why no card was found.
export function typedCard(rows, date) {
  const pick = chooseTyped(rows, date);
  return pick.row ? { hash: pick.row.token_hash, miss: null } : { hash: '', miss: pick.reason };
}
