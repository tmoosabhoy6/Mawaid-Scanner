import { bareTourId } from './rules.js';
// Plans a Google Sheet import against the stays already stored. A tour ID holds one stay at a time: the overlap
// triggers check every stay, active or not, so one overlapping row used to refuse the whole import.
// - A stay already stored for the same tour ID and arrival is updated in place.
// - A stay whose arrival was corrected in the Sheet moves the stored stay to the new dates, keeping its people,
//   cards and meals. A stay added by hand with the ID typed without the Sheet's 26/ prefix is taken over the
//   same way, so the tour is not listed twice.
// - A stay that would still overlap another stay is left out with a warning; the rest of the Sheet is imported.
// - The Sheet can add to a stay with printed cards but never take away from it, so an everyday edit cannot turn
//   cards red: its PAX never drops below the cards printed, and its dates only widen. Notes list each such stay.
// Steps run in the returned order, each against the state the earlier steps leave, so no step trips a trigger.
// Stored rows carry issued, the number of people with cards. Notes cover stays departing today or later.
const overlaps = (row, tour) => row.arrival <= tour.departure && row.departure >= tour.arrival;
const min = (a, b) => a < b ? a : b, max = (a, b) => a > b ? a : b;
export function planSync(existing, tours, today = '') {
  const rows = existing.map(row => ({ ...row })), listed = new Set(tours.map(t => `${t.tour_id}|${t.arrival}`));
  const claimed = new Set(), steps = [], skipped = [], notes = [];
  for (const tour of [...tours].sort((a, b) => a.arrival.localeCompare(b.arrival) || a.tour_id.localeCompare(b.tour_id))) {
    const target = rows.find(r => r.tour_id === tour.tour_id && r.arrival === tour.arrival) || rows.find(r => !claimed.has(r.id) && r.source_key === tour.source_key) || rows
      .filter(r => !claimed.has(r.id) && r.tour_id && bareTourId(r.tour_id) === bareTourId(tour.tour_id) && overlaps(r, tour) && !listed.has(`${r.tour_id}|${r.arrival}`))
      .sort((a, b) => (b.source === 'sheets') - (a.source === 'sheets') || b.active - a.active || a.arrival.localeCompare(b.arrival))[0];
    const issued = target?.issued || 0;
    const next = { tour_id: tour.tour_id, arrival: issued ? min(target.arrival, tour.arrival) : tour.arrival, departure: issued ? max(target.departure, tour.departure) : tour.departure,
      office: tour.office, pax: Math.max(tour.pax, issued), source: 'sheets', source_key: tour.source_key, active: 1 };
    if (rows.some(r => r !== target && ((r.tour_id === next.tour_id && overlaps(r, next)) || r.source_key === next.source_key))) { skipped.push(tour); continue; }
    if (!target) { rows.push({ id: tour.id, ...next, issued: 0 }); steps.push({ insert: tour }); continue; }
    claimed.add(target.id);
    if (next.departure >= today && tour.pax < issued) notes.push(`${tour.tour_id}: the Sheet has ${tour.pax} PAX but ${issued} cards are printed; every printed card still works.`);
    if (next.departure >= today && (next.arrival !== tour.arrival || next.departure !== tour.departure)) notes.push(`${tour.tour_id}: the Sheet has ${tour.arrival} to ${tour.departure}; its printed cards keep working ${next.arrival} to ${next.departure}.`);
    if (Object.keys(next).some(k => target[k] !== next[k])) steps.push({ update: target.id, tour: { ...tour, ...next } });
    Object.assign(target, next);
  }
  return { steps, skipped, notes, claimed };
}
export const skippedWarning = t => `${t.tour_id} (${t.arrival}): overlaps another stay of the same tour ID; not imported. Correct the dates in the Sheet or on the Tours page.`;
// Tours the Sheet still lists but left out with a warning, such as a half-finished edit where the arrival and Wada
// PAX differ. Every warning the Apps Script sends starts with the tour ID. Their current stays are kept active, or
// switched back on, with the details of the last complete sync, so printed cards keep working until the Sheet is fixed.
export const heldTourIds = warnings => [...new Set(warnings.map(w => /^(\d{2}\/\d{1,5}|\d{4})[\s:]/.exec(w)?.[1]).filter(Boolean))];
// Stored Sheet stays that this import does not switch off: those the Sheet still lists with a warning or for an
// overlap, and those with printed cards. Current ones (departing today or later) are switched back on if they were off.
export function keptStays(stored, plan, held, today) {
  const keep = new Set([...held, ...plan.skipped.map(t => t.tour_id)]), notes = [];
  const kept = stored.filter(r => r.source === 'sheets' && !plan.claimed.has(r.id) && r.departure >= today && (keep.has(r.tour_id) || r.issued > 0));
  const listed = kept.filter(r => keep.has(r.tour_id)).map(r => r.tour_id), gone = kept.filter(r => !keep.has(r.tour_id));
  if (listed.length) notes.push(`Kept active with the details of the last complete sync until the Sheet is fixed: ${[...new Set(listed)].join(', ')}.`);
  for (const r of gone) notes.push(`${r.tour_id || r.office} (${r.arrival}): no longer in the Sheet; its ${r.issued} printed cards still work.`);
  return { keep: [...keep], notes };
}
