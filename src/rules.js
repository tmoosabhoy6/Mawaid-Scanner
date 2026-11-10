export const TIME_ZONE = 'Asia/Baghdad';
export const START_DATE = '2026-10-21';
const localClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function localTime(now = new Date()) {
  const parts = Object.fromEntries(localClock.formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute, seconds: +parts.second };
}
export const MEALS = [
  { id: 'breakfast', label: 'Breakfast', start: 0, end: 11 * 60, hours: 'until 11:00 am' },
  { id: 'lunch', label: 'Lunch', start: 11 * 60, end: 19 * 60, hours: '11:00 am–7:00 pm' },
  { id: 'dinner', label: 'Dinner', start: 19 * 60, end: 24 * 60, hours: 'from 7:00 pm' },
];
// Meals cover the whole Karbala day: anything before lunch starts is breakfast, anything before dinner
// starts is lunch, and the rest of the day is dinner. They only stop a second admission for the same meal.
export function serviceAt(now) {
  const { date, minutes } = localTime(now);
  const meal = MEALS.find(m => minutes >= m.start && minutes < m.end);
  return { date, meal: meal?.id || null, mealLabel: meal?.label || null, meals: MEALS };
}
export function eligibility(card, now) {
  const service = serviceAt(now);
  if (!card || card.revoked_at) return { allowed: false, reason: card ? 'replaced_card' : 'unknown_card', ...service };
  if (service.date < card.arrival) return { allowed: false, reason: 'before_arrival', ...service };
  if (service.date > card.departure) return { allowed: false, reason: 'after_departure', ...service };
  if (!service.meal) return { allowed: false, reason: 'outside_meal_time', ...service };
  return { allowed: true, reason: 'admitted', ...service };
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const text = value => String(value ?? '').trim();
// Tour ID and ITS are optional for tours added by hand; the Google Sheet sync always sends a tour ID.
export function validateTour(input, { requireId = true } = {}) {
  const tour = { tour_id: text(input.tour_id) || null, its: text(input.its) || null, office: text(input.office),
    arrival: input.arrival, departure: input.departure, pax: Number(input.pax) };
  if (requireId && !tour.tour_id) throw new Error('Enter a tour ID.');
  if ((tour.tour_id || '').length > 80 || !tour.office || tour.office.length > 160) throw new Error('Enter an office name (maximum 160 characters) and a tour ID of up to 80 characters.');
  if ((tour.its || '').length > 40) throw new Error('ITS can be up to 40 characters.');
  if (!validDate(tour.arrival) || !validDate(tour.departure) || tour.arrival > tour.departure) throw new Error('Enter valid arrival and departure dates in order.');
  if (!Number.isInteger(tour.pax) || tour.pax < 1 || tour.pax > 10000) throw new Error('PAX must be a whole number from 1 to 10,000.');
  return tour;
}
// The Google Sheet writes tour IDs with a year prefix ("26/2849"); staff adding a tour by hand often type "2849".
// The Sheet sync uses this to take over a tour added by hand before the Sheet listed it (see sync-plan.js).
export const bareTourId = id => String(id).toLowerCase().replace(/^\d{2}\//, '');
// A tour added by hand is always a new tour with its own cards. Its tour ID is optional, but one tour ID cannot hold
// two overlapping stays (the database refuses it), so this finds the stay that would clash. Params: tour ID, arrival, departure.
export const TOUR_ID_CLASH_SQL = 'SELECT tour_id,arrival,departure FROM tours WHERE tour_id=? AND arrival<=? AND departure>=? LIMIT 1';
export const tourIdClash = clash => `Tour ID ${clash.tour_id} is already used for ${clash.arrival} to ${clash.departure}. Leave the tour ID blank, or use another one, to add these guests as a new tour with new cards.`;
// Safari (takeaway) cards have no QR code, and every field is optional.
export function validateSafari(input) {
  const blank = value => value === undefined || value === null || value === '';
  const safari = { office: text(input.office) || null, tour_id: text(input.tour_id) || null, its: text(input.its) || null,
    arrival: blank(input.arrival) ? null : input.arrival, departure: blank(input.departure) ? null : input.departure,
    pax: blank(input.pax) ? null : Number(input.pax) };
  if ((safari.office || '').length > 160 || (safari.tour_id || '').length > 80 || (safari.its || '').length > 40) throw new Error('Use up to 160 characters for the name, 80 for the tour ID and 40 for ITS.');
  if ([safari.arrival, safari.departure].some(d => d !== null && !validDate(d))) throw new Error('Enter valid dates, or leave them blank.');
  if (safari.arrival && safari.departure && safari.arrival > safari.departure) throw new Error('The departure date must be on or after arrival.');
  if (safari.pax !== null && (!Number.isInteger(safari.pax) || safari.pax < 1 || safari.pax > 10000)) throw new Error('PAX must be a whole number from 1 to 10,000, or blank.');
  return safari;
}
