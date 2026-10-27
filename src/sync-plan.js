import { bareTourId } from './rules.js';
// Plans a Google Sheet import against the stays already stored. A tour ID holds one stay at a time: the overlap
// triggers check every stay, active or not, so one overlapping row used to refuse the whole import.
// - A stay already stored for the same tour ID and arrival is updated in place.
// - A stay whose arrival was corrected in the Sheet moves the stored stay to the new dates, keeping its people,
//   cards and meals. A stay added by hand with the ID typed without the Sheet's 26/ prefix is taken over the
//   same way, so the tour is not listed twice.
// - A stay that would still overlap another stay is left out with a warning; the rest of the Sheet is imported.
// Steps run in the returned order, each against the state the earlier steps leave, so no step trips a trigger.
const overlaps = (row, tour) => row.arrival <= tour.departure && row.departure >= tour.arrival;
export function planSync(existing, tours) {
  const rows = existing.map(row => ({ ...row })), listed = new Set(tours.map(t => `${t.tour_id}|${t.arrival}`));
  const claimed = new Set(), steps = [], skipped = [];
  for (const tour of [...tours].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.tour_id.localeCompare(b.tour_id))) {
    const target = rows.find(r => r.tour_id === tour.tour_id && r.arrival === tour.arrival) || rows
      .filter(r => !claimed.has(r.id) && r.tour_id && bareTourId(r.tour_id) === bareTourId(tour.tour_id) && overlaps(r, tour) && !listed.has(`${r.tour_id}|${r.arrival}`))
      .sort((a, b) => (b.source === 'sheets') - (a.source === 'sheets') || b.active - a.active || a.arrival.localeCompare(b.arrival))[0];
    if (rows.some(r => r !== target && ((r.tour_id === tour.tour_id && overlaps(r, tour)) || r.source_key === tour.source_key))) { skipped.push(tour); continue; }
    const next = { tour_id: tour.tour_id, arrival: tour.arrival, departure: tour.departure, office: tour.office, pax: tour.pax, source: 'sheets', source_key: tour.source_key, active: 1 };
    if (!target) { rows.push({ id: tour.id, ...next }); steps.push({ insert: tour }); continue; }
    claimed.add(target.id);
    if (Object.keys(next).some(k => target[k] !== next[k])) steps.push({ update: target.id, tour });
    Object.assign(target, next);
  }
  return { steps, skipped };
}
export const skippedWarning = t => `${t.tour_id} (${t.arrival}): overlaps another stay of the same tour ID; not imported. Correct the dates in the Sheet or on the Tours page.`;
// Tours the Sheet still lists but left out with a warning, such as a half-finished edit where the arrival and Wada
// PAX differ. Every warning the Apps Script sends starts with the tour ID. Their current stays are kept active, or
// switched back on, with the details of the last complete sync, so printed cards keep working until the Sheet is fixed.
export const heldTourIds = warnings => [...new Set(warnings.map(w => /^(\d{2}\/\d{1,5}|\d{4})[\s:]/.exec(w)?.[1]).filter(Boolean))];
export const heldWarning = ids => `Kept active with the details of the last complete sync until the Sheet is fixed: ${ids.join(', ')}.`;
