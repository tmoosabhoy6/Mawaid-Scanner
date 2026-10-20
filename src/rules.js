export const TIME_ZONE = 'Asia/Baghdad';
export const START_DATE = '2026-10-21';
// Tours list cap; keeps the Worker within the free plan's CPU limit.
export const TOUR_LIST_LIMIT = 1000;
export const MEALS = [
  { id: 'breakfast', name: 'Breakfast', start: 390, end: 540, hours: '6:30–9:00 am' },
  { id: 'lunch', name: 'Lunch', start: 750, end: 900, hours: '12:30–3:00 pm' },
  { id: 'dinner', name: 'Dinner', start: 1140, end: 1290, hours: '7:00–9:30 pm' },
];
export function localTime(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute, seconds: +parts.second };
}
export function serviceAt(now) {
  const t = localTime(now);
  return { ...t, meal: t.date >= START_DATE ? MEALS.find(m => t.minutes >= m.start && t.minutes < m.end) || null : null };
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
export function validateTour(input) {
  const tour = { tour_id: String(input.tour_id || '').trim(), office: String(input.office || '').trim(),
    arrival: input.arrival, departure: input.departure, pax: Number(input.pax) };
  if (!tour.tour_id || tour.tour_id.length > 80 || !tour.office || tour.office.length > 160) throw new Error('Enter a tour ID and office (maximum 80 and 160 characters).');
  if (!validDate(tour.arrival) || !validDate(tour.departure) || tour.arrival > tour.departure) throw new Error('Enter valid arrival and departure dates in order.');
  if (!Number.isInteger(tour.pax) || tour.pax < 1 || tour.pax > 10000) throw new Error('PAX must be a whole number from 1 to 10,000.');
  return tour;
}
