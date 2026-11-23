// Guests turned away at the gate although they were entitled to the meal (live, 20–23 November 2026). Each test below
// is one of those cases. Karbala is UTC+3: 10:00Z is lunch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, tour, issue, scan } from './helpers.js';
import { looseTyped, currentTyped } from '../src/sticker.js';

const typed = (f, number) => f.scanner.post('/api/scan').send({ number, requestKey: randomUUID() });
// A Sheet stay added straight into the database, as the Sheet sync does (Add tour gives a known ID's stay shared_tour_id).
function sheetStay(f, tour_id, arrival, departure, pax = 2) {
  const id = randomUUID();
  f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at) VALUES(?,?,'FH Karachi',?,?,?,'sheets',?,?)")
    .run(id, tour_id, arrival, departure, pax, `sheet|Tours|${tour_id}|${arrival}`, f.getTime().toISOString());
  return id;
}
const nkerp = (f, visits) => f.db.prepare("INSERT INTO settings(key,value) VALUES('nkerp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(JSON.stringify({ checkedAt: f.getTime().toISOString(), visits }));

test('a card printed for the tour’s other visit is let in while the tour is in Karbala (26/3595)', async () => {
  const f = await fixture(); try {
    sheetStay(f, '26/3595', '2026-10-21', '2026-10-26', 5);
    const december = sheetStay(f, '26/3595', '2026-12-21', '2026-12-26', 5), { cards } = await issue(f, december);
    f.setTime('2026-10-22T10:00:00Z');
    const r = await scan(f, cards[0].token);
    assert.deepEqual([r.body.status, r.body.reason], ['green', 'admitted']);
    assert.equal((await scan(f, cards[0].token)).body.reason, 'already_scanned', 'still one meal per card');
    // Once the November visit has ended and before December's starts, the tour is not here: the card is red again.
    f.setTime('2026-10-28T10:00:00Z');
    assert.deepEqual([(await scan(f, cards[1].token)).body.status, (await scan(f, cards[2].token)).body.reason], ['red', 'before_arrival']);
  } finally { f.close(); }
});

test('a stay added by hand with the wrong dates is let in while its tour ID’s Sheet stay covers the day (26/3629)', async () => {
  const f = await fixture(); try {
    sheetStay(f, '26/3629', '2026-10-21', '2026-10-26', 27);
    // Staff added more guests under 26/3629 starting a day late.
    const extra = await tour(f, 2, { tour_id: '26/3629', office: '', arrival: '2026-10-23', departure: '2026-10-26' });
    assert.equal(f.db.prepare('SELECT shared_tour_id FROM tours WHERE id=?').get(extra.id).shared_tour_id, '26/3629');
    const { cards } = await issue(f, extra.id);
    f.setTime('2026-10-22T10:00:00Z');
    assert.equal((await scan(f, cards[0].token)).body.reason, 'admitted');
  } finally { f.close(); }
});

test('NKERP’s Karbala visit lets a guest in when the app’s stay has the wrong dates or was switched off (26/3449)', async () => {
  const f = await fixture(); try {
    // The app only knows the December stay; NKERP has the tour in Karbala now (the Sheet sync had stopped).
    const december = sheetStay(f, '26/3449', '2026-12-17', '2026-12-22', 3), { cards } = await issue(f, december);
    f.setTime('2026-10-22T10:00:00Z');
    assert.equal((await scan(f, cards[0].token)).body.reason, 'before_arrival', 'no record puts the tour here yet');
    nkerp(f, [['26/3449', '2026-10-20T15:10', '2026-10-24'], ['26/9999', '2026-10-01T10:00', '2026-10-30']]);
    assert.deepEqual([(await scan(f, cards[0].token)).body.status, (await scan(f, cards[1].token)).body.reason], ['green', 'admitted']);
    // A stay switched off is let in too while NKERP has the tour here.
    f.db.prepare('UPDATE tours SET active=0 WHERE id=?').run(december);
    assert.equal((await scan(f, cards[2].token)).body.reason, 'admitted');
    // After NKERP's departure the card is red again, with the card's own reason.
    f.setTime('2026-10-25T10:00:00Z');
    assert.equal((await scan(f, cards[0].token)).body.reason, 'inactive_tour');
    // Phones get the same ranges for their offline check, without any tour ID.
    f.setTime('2026-10-22T10:00:00Z');
    f.db.prepare('UPDATE tours SET active=1 WHERE id=?').run(december);
    const data = (await f.scanner.get('/api/scanner/data').expect(200)).body, stay = data.tours.find(t => t[0] === december);
    assert.deepEqual(stay.slice(1), ['2026-12-17', '2026-12-22', 3, 1, [['2026-12-17', '2026-12-22'], ['2026-10-20', '2026-10-24']]]);
    assert.doesNotMatch(JSON.stringify(data), /26\/3449|9999|FH Karachi/);
  } finally { f.close(); }
});

test('a guest of a tour that no record puts in Karbala is still turned away', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 2, { arrival: '2026-10-24', departure: '2026-10-26' }), { cards } = await issue(f, t.id);
    nkerp(f, [['26/3205', '2026-10-24T10:00', '2026-10-26'], ['26/1111', '2026-10-21T10:00', '2026-10-23']]);
    f.setTime('2026-10-22T10:00:00Z');
    assert.equal((await scan(f, cards[0].token)).body.reason, 'before_arrival');
    f.setTime('2026-10-27T10:00:00Z');
    assert.equal((await scan(f, cards[0].token)).body.reason, 'after_departure');
  } finally { f.close(); }
});

test('a typed card number with its leading zero left off or doubled finds the guest staying today', async () => {
  assert.deepEqual(looseTyped('83210'), ['083210']); assert.deepEqual(looseTyped('0193045'), ['193045']);
  assert.deepEqual(looseTyped('3382'), [], 'a four-digit tour number is never re-read');
  assert.equal(currentTyped([{ arrival: '2026-10-21', departure: '2026-10-23', token_hash: 'x' }], '2026-10-24'), null);
  const f = await fixture(); try {
    const t = await tour(f, 9), { cards } = await issue(f, t.id);
    f.setTime('2026-10-21T10:00:00Z');
    // Live: 83210 for card 083210, 32443 for 032443.
    const dropped = await typed(f, '83205');
    assert.deepEqual([dropped.body.status, dropped.body.reason, dropped.body.card_id, dropped.body.typed_code], ['green', 'admitted', cards[7].id, '83205']);
    assert.equal((await typed(f, '083205')).body.reason, 'already_scanned', 'the same guest');
    // An extra zero in front: 0093205 for card 093205.
    const doubled = await typed(f, '0093205');
    assert.deepEqual([doubled.body.reason, doubled.body.card_id], ['admitted', cards[8].id]);
    // The tour number alone still counts one guest of the tour, as before.
    assert.equal((await typed(f, '3205')).body.by_tour, 1);
    // A mistyped reading of a guest who is not staying today is not used.
    f.setTime('2026-10-25T10:00:00Z');
    assert.equal((await typed(f, '13205')).body.reason, 'unknown_number');
  } finally { f.close(); }
});
