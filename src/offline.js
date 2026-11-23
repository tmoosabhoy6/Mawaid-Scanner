// Gate phones keep a copy of the cards of current stays, so they can keep checking cards when the Wi-Fi drops.
// The first download holds every current card and today's meals; after that each minute's poll reads only
// cards and meals added since the phone's cursors. A person whose card was replaced (in the past) has a newer card,
// so a phone that receives a person's new card treats that person's older cards as replaced. Every poll also carries
// the current stays that have cards (dates, PAX, active), so Sheet changes reach the phones within a minute; stays
// with no cards cannot be scanned and are left out to keep the poll small. It also carries all of today's meals counted
// by typing a tour number, since those can move from one guest to another. Only random card hashes, dates, person
// numbers and the card numbers printed under the QR (so a number typed at the gate can be checked offline too) are
// sent — no names or offices.
const CURRENT_TOURS = 'SELECT id FROM tours WHERE departure>=?1';
export const OFFLINE_SQL = {
  cardCursor: 'SELECT COALESCE(MAX(rowid),0) AS n FROM cards',
  admissionCursor: 'SELECT COALESCE(MAX(rowid),0) AS n FROM admissions',
  tours: 'SELECT t.id,t.arrival,t.departure,t.pax,t.active,COALESCE(t.tour_id,t.shared_tour_id) AS tid FROM tours t WHERE t.departure>=?1 AND EXISTS(SELECT 1 FROM people p WHERE p.tour_id=t.id)',
  // When each tour is in Karbala by another of its stays (see tourHereSql in scan-query.js): the active stays under its
  // tour ID that have not ended. Sent as date ranges per stay, never the tour IDs themselves. A stay moved off a late
  // Pehli by NKERP (src/nkerp.js) already carries its moved arrival, so the phone needs nothing from NKERP itself.
  stayRanges: 'SELECT COALESCE(tour_id,shared_tour_id) AS tid,arrival,departure FROM tours WHERE active=1 AND departure>=?1 AND COALESCE(tour_id,shared_tour_id) IS NOT NULL ORDER BY arrival',
  allCards: `SELECT c.token_hash,p.id AS person_id,p.tour_id,p.person_no,c.revoked_at IS NOT NULL AS revoked,p.sticker_no,p.sticker_tour
    FROM people p JOIN cards c ON c.person_id=p.id WHERE p.tour_id IN (${CURRENT_TOURS}) AND c.rowid<=?2`,
  newCards: `SELECT c.token_hash,p.id AS person_id,p.tour_id,p.person_no,c.revoked_at IS NOT NULL AS revoked,p.sticker_no,p.sticker_tour
    FROM cards c JOIN people p ON p.id=c.person_id WHERE c.rowid>?1 AND c.rowid<=?2`,
  allAdmissions: 'SELECT person_id,meal FROM admissions WHERE date=?1 AND rowid<=?2 AND by_tour=0',
  // NOT INDEXED keeps this to a rowid range, so a poll reads only the meals served since the last one.
  newAdmissions: 'SELECT person_id,meal FROM admissions NOT INDEXED WHERE rowid>?1 AND rowid<=?2 AND date=?3 AND by_tour=0',
  // Meals taken by typing a tour number move to another guest when the guest they were counted for scans their own card
  // (see scan-query.js), so every poll carries all of today's, read through the partial index admissions_by_tour.
  tourAdmissions: 'SELECT person_id,meal FROM admissions WHERE date=?1 AND by_tour=1',
};
// all(sql, ...params) returns rows; it may be synchronous (Node) or asynchronous (Worker).
export async function offlineData(all, url, service, hashFormat) {
  const cursor = key => { const n = Number(url.searchParams.get(key) || 0); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
  const today = service.date, cardsAfter = cursor('cards'), admissionsAfter = url.searchParams.get('date') === today ? cursor('admissions') : 0;
  const withTours = !cardsAfter || url.searchParams.get('tours') === '1';
  const cardCursor = (await all(OFFLINE_SQL.cardCursor))[0].n, admissionCursor = (await all(OFFLINE_SQL.admissionCursor))[0].n;
  const cards = cardsAfter ? await all(OFFLINE_SQL.newCards, cardsAfter, cardCursor) : await all(OFFLINE_SQL.allCards, today, cardCursor);
  const admissions = admissionsAfter ? await all(OFFLINE_SQL.newAdmissions, admissionsAfter, admissionCursor, today) : await all(OFFLINE_SQL.allAdmissions, today, admissionCursor);
  const data = { ...service, hash: hashFormat, full: !cardsAfter, cardCursor, admissionCursor,
    cards: cards.map(c => [c.token_hash, c.person_id, c.tour_id, c.person_no, c.revoked ? 1 : 0, c.sticker_no ?? null, c.sticker_tour ?? null]),
    admissions: admissions.map(a => [a.person_id, a.meal]),
    tourAdmissions: (await all(OFFLINE_SQL.tourAdmissions, today)).map(a => [a.person_id, a.meal]) };
  if (withTours) {
    const here = new Map(), add = (key, arrival, departure) => { if (!here.has(key)) here.set(key, []); here.get(key).push([arrival, departure]); };
    for (const r of await all(OFFLINE_SQL.stayRanges, today)) add(r.tid, r.arrival, r.departure);
    // Each stay: id, arrival, departure, PAX, active, and the date ranges in which its tour is in Karbala.
    data.tours = (await all(OFFLINE_SQL.tours, today)).map(t => [t.id, t.arrival, t.departure, t.pax, t.active ? 1 : 0, here.get(t.tid) || []]);
  }
  return data;
}
