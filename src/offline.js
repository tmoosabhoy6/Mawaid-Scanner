// Gate phones keep a copy of the cards of current stays, so they can keep checking cards when the Wi-Fi drops.
// The first download holds every current card and today's meals; after that each minute's poll reads only
// cards and meals added since the phone's cursors. A replacement always adds a card, so a phone that receives
// a person's new card treats that person's older cards as replaced. Tours and extensions are small and are
// re-read every few minutes. Only random card hashes, dates and person numbers are sent — no names or offices.
const CURRENT_TOURS = `SELECT id FROM tours WHERE departure>=?1
  UNION SELECT tour_id FROM tour_extensions WHERE date>=?1 AND removed_at IS NULL`;
export const OFFLINE_SQL = {
  cardCursor: 'SELECT COALESCE(MAX(rowid),0) AS n FROM cards',
  admissionCursor: 'SELECT COALESCE(MAX(rowid),0) AS n FROM admissions',
  tours: `SELECT t.id,t.arrival,t.departure,t.pax,t.active FROM tours t WHERE t.id IN (${CURRENT_TOURS})`,
  extensions: 'SELECT tour_id,date,meals FROM tour_extensions WHERE date>=?1 AND removed_at IS NULL',
  allCards: `SELECT c.token_hash,p.id AS person_id,p.tour_id,p.person_no,c.revoked_at IS NOT NULL AS revoked
    FROM people p JOIN cards c ON c.person_id=p.id WHERE p.tour_id IN (${CURRENT_TOURS}) AND c.rowid<=?2`,
  newCards: `SELECT c.token_hash,p.id AS person_id,p.tour_id,p.person_no,c.revoked_at IS NOT NULL AS revoked
    FROM cards c JOIN people p ON p.id=c.person_id WHERE c.rowid>?1 AND c.rowid<=?2`,
  allAdmissions: 'SELECT person_id,meal FROM admissions WHERE date=?1 AND rowid<=?2',
  // NOT INDEXED keeps this to a rowid range, so a poll reads only the meals served since the last one.
  newAdmissions: 'SELECT person_id,meal FROM admissions NOT INDEXED WHERE rowid>?1 AND rowid<=?2 AND date=?3',
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
    cards: cards.map(c => [c.token_hash, c.person_id, c.tour_id, c.person_no, c.revoked ? 1 : 0]),
    admissions: admissions.map(a => [a.person_id, a.meal]) };
  if (withTours) {
    data.tours = (await all(OFFLINE_SQL.tours, today)).map(t => [t.id, t.arrival, t.departure, t.pax, t.active ? 1 : 0]);
    data.extensions = (await all(OFFLINE_SQL.extensions, today)).map(x => [x.tour_id, x.date, x.meals]);
  }
  return data;
}
