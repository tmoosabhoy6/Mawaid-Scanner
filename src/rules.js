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
// A tour added by hand is the same tour as a listed one when the IDs match without that prefix and the stays
// overlap, so it reuses that tour's cards instead of adding a second entry. Params: bare ID, arrival, departure, ID.
export const bareTourId = id => String(id).toLowerCase().replace(/^\d{2}\//, '');
export const SAME_TOUR_SQL = `SELECT t.*,(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued FROM tours t
  WHERE lower(CASE WHEN t.tour_id GLOB '[0-9][0-9]/*' THEN substr(t.tour_id,4) ELSE t.tour_id END)=?1
  AND t.arrival<=?3 AND t.departure>=?2 AND (t.active=1 OR t.tour_id=?4)
  ORDER BY t.arrival=?2 DESC,t.active DESC,t.source='sheets' DESC,t.created_at LIMIT 1`;
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
export const addDays = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
// An extension adds meals on one day after the stay ends: the whole day, or lunch only. The same QR cards keep working.
export const EXTENSION_MEALS = { day: 'Whole day', lunch: 'Lunch only' };
export const MAX_EXTENSION_DAYS = 30;
export function validateExtension(input, tour, today) {
  const date = input?.date, meals = input?.meals;
  if (!Object.hasOwn(EXTENSION_MEALS, meals)) throw new Error('Choose Whole day or Lunch only.');
  if (!validDate(date)) throw new Error('Choose the day to extend.');
  if (!tour) throw Object.assign(new Error('Tour not found.'), { status: 404 });
  if (!tour.active) throw new Error('This tour is no longer active in the source sheet.');
  if (date <= tour.departure) throw new Error(`Every meal up to ${tour.departure} is already included. Choose a later day.`);
  if (date < today) throw new Error('Choose today or a later day.');
  if (date > addDays(tour.departure, MAX_EXTENSION_DAYS)) throw new Error(`Extend up to ${MAX_EXTENSION_DAYS} days after departure.`);
  return { date, meals };
}
