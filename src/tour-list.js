// Tours page "Show" and "Sort by" choices, shared by the Node server and the Worker. They run in SQL before the
// 1,000-row cap, so the rows kept are the ones the page asked for. Finished stays are always listed.
// p is the table prefix ('t.' for tours, 's.' for Safari cards); undated Safari cards always come last.
export function listOrder(sort, p) {
  const arrival = sort === 'oldest' ? `${p}arrival` : `${p}arrival DESC`;
  return sort === 'tour' ? `${p}tour_id IS NULL,${p}tour_id,${p}arrival IS NULL,${p}arrival` : `${p}arrival IS NULL,${arrival},${p}tour_id`;
}
// A tour is printed once every person has a card; a part-printed tour still needs cards, so it shows as not printed.
export const tourStatus = status => ({ printed: '(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id)>=t.pax', unprinted: '(SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id)<t.pax' })[status] || '1=1';
// A Safari card is printed once any sticker job holds it.
const safariPrinted = 'EXISTS(SELECT 1 FROM safari_prints sp JOIN batches b ON b.id=sp.batch_id WHERE sp.safari_id=s.id)';
export const safariStatus = status => ({ printed: safariPrinted, unprinted: `NOT ${safariPrinted}` })[status] || '1=1';
