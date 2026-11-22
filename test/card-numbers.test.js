import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, tour, issue, scan } from './helpers.js';
import { stickerTour, stickerCode, typedCandidates, chooseTyped, assignStickers } from '../src/sticker.js';

// Karbala is UTC+3: 04:00Z is breakfast, 10:00Z lunch, 16:30Z dinner.
const typed = (f, number, extra = {}) => f.scanner.post('/api/scan').send({ number, requestKey: randomUUID(), ...extra });
const numbers = cards => cards.map(c => stickerCode(c.sticker_no, c.sticker_tour));

test('card numbers: the sticker number in two digits, then the tour number without its year', () => {
  assert.equal(stickerTour('26/5253'), '5253'); assert.equal(stickerTour('26/5'), '5'); assert.equal(stickerTour('2938'), '2938');
  assert.equal(stickerTour('MAIMOON TOUR'), null); assert.equal(stickerTour(null), null); assert.equal(stickerTour('26/1234567'), null);
  assert.equal(stickerCode(37, '5253'), '375253'); assert.equal(stickerCode(1, '5253'), '015253'); assert.equal(stickerCode(123, '5253'), '1235253');
  assert.equal(stickerCode(null, '5253'), ''); assert.equal(stickerCode(1, null), '');
  // Two digits always; three only when the number really is 100 or more, so 015253 never reads as sticker 15.
  assert.deepEqual(typedCandidates('375253'), [{ no: 37, tour: '5253' }, { no: 375, tour: '253' }, { no: 3752, tour: '53' }]);
  assert.deepEqual(typedCandidates('015253'), [{ no: 1, tour: '5253' }]);
  assert.deepEqual(typedCandidates(' 37 5253 '), typedCandidates('375253'), 'spaces are ignored');
  assert.deepEqual(typedCandidates('37-5253'), typedCandidates('375253'), 'a dash is ignored');
  for (const bad of ['', '37', 'MW1:abc', '37a253', '005253', '1234567890123']) assert.deepEqual(typedCandidates(bad), [], bad);
  // A number that matches no stay, one stay, two stays covering the date, or only stays on other dates.
  const stay = (arrival, departure) => ({ arrival, departure, token_hash: `${arrival}` });
  assert.deepEqual(chooseTyped([], '2026-11-16'), { reason: 'unknown_number' });
  assert.equal(chooseTyped([stay('2026-10-11', '2026-10-16'), stay('2026-11-11', '2026-11-16')], '2026-11-16').row.arrival, '2026-11-11');
  assert.deepEqual(chooseTyped([stay('2026-11-11', '2026-11-16'), stay('2026-11-14', '2026-11-20')], '2026-11-15'), { reason: 'ambiguous_number' });
  assert.equal(chooseTyped([stay('2026-10-11', '2026-10-16'), stay('2026-11-18', '2026-11-20')], '2026-11-16').row.arrival, '2026-11-18', 'the nearest stay');
  // In one print job, overlapping stays of the same tour number continue from each other; other stays start again.
  const job = assignStickers([
    { tour_key: 'a', tour_id: '26/7', arrival: '2026-11-01', departure: '2026-11-05' }, { tour_key: 'a', tour_id: '26/7', arrival: '2026-11-01', departure: '2026-11-05' },
    { tour_key: 'b', tour_id: '26/7', arrival: '2026-11-04', departure: '2026-11-06' }, { tour_key: 'c', tour_id: '26/7', arrival: '2026-12-01', departure: '2026-12-05' },
    { tour_key: 'd', tour_id: 'NAME', arrival: '2026-11-01', departure: '2026-11-05' }], new Map([['a', 10]]));
  assert.deepEqual(job.map(c => c.sticker_no), [11, 12, 13, 1, null]);
});

test('printing numbers each card, and a typed number is checked exactly like that card’s QR', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 3), { cards } = await issue(f, t.id);
    assert.deepEqual(numbers(cards), ['013205', '023205', '033205']);
    assert.deepEqual(f.db.prepare('SELECT person_no,sticker_no,sticker_tour FROM people ORDER BY person_no').all().map(r => ({ ...r })),
      [1, 2, 3].map(n => ({ person_no: n, sticker_no: n, sticker_tour: '3205' })));
    f.setTime('2026-10-21T10:00:00Z');
    const first = await typed(f, '023205', { gate: 'women' });
    assert.deepEqual([first.body.status, first.body.reason, first.body.person_id, first.body.card_id, first.body.typed_code, first.body.gate, first.body.meal],
      ['green', 'admitted', cards[1].person_id, cards[1].id, '023205', 'women', 'lunch']);
    // The same guest again, typed or by QR, is a duplicate for this meal.
    const again = await typed(f, '02 3205');
    assert.deepEqual([again.body.status, again.body.reason, again.body.firstScannedAt], ['red', 'already_scanned', first.body.scanned_at]);
    assert.equal((await scan(f, cards[1].token)).body.reason, 'already_scanned');
    // A QR admitted first makes the typed number a duplicate too.
    assert.equal((await scan(f, cards[0].token)).body.reason, 'admitted');
    assert.equal((await typed(f, '013205')).body.reason, 'already_scanned');
    // A number nobody holds is red at lunch; breakfast lets everyone in without counting them.
    const unknown = await typed(f, '093205');
    assert.deepEqual([unknown.body.status, unknown.body.reason, unknown.body.message, unknown.body.typed_code], ['red', 'unknown_number', 'No card or tour has this number. Check the number, or scan the QR code', '093205']);
    assert.equal((await typed(f, '019999')).body.reason, 'unknown_number');
    f.setTime('2026-10-22T04:00:00Z');
    assert.deepEqual([(await typed(f, '093205')).body.reason, (await typed(f, '093205')).body.status], ['breakfast_unlisted', 'green']);
    assert.equal((await typed(f, '033205')).body.reason, 'admitted');
    // The stay's dates still apply.
    f.setTime('2026-10-24T10:00:00Z');
    assert.deepEqual([(await typed(f, '033205')).body.reason, (await typed(f, '033205')).body.status], ['after_departure', 'red']);
    // Something that is neither a card number nor a tour number is refused outright; a tour number nobody has is red.
    for (const bad of ['', 'abc', '1/3205', '26/32/05', 3205]) assert.equal((await typed(f, bad)).status, 400, String(bad));
    for (const none of ['12', '005253']) assert.equal((await typed(f, none)).body.reason, 'unknown_number', none);
    // The scan log marks typed scans.
    const log = (await f.admin.get('/api/logs?date=2026-10-21').expect(200)).body;
    assert.deepEqual(log.filter(r => r.typed_code).map(r => r.typed_code).sort(), ['013205', '019999', '023205', '023205', '093205'], 'typed with spaces, kept as digits');
    assert.ok(log.some(r => !r.typed_code), 'QR scans have no typed number');
  } finally { f.close(); }
});

test('a stay added under the same tour ID, and a PAX raised later, continue the numbers; a later visit starts again', async () => {
  const f = await fixture(); try {
    const first = await tour(f, 2), { cards: a } = await issue(f, first.id);
    // Lost cards: Add tour under the same ID while the first stay is still here. Its people are 1 and 2 of their stay,
    // but their stickers must not repeat 01 and 02.
    const extra = await tour(f, 2, { office: '', arrival: '2026-10-22', departure: '2026-10-23' });
    assert.equal(extra.shared, true);
    const { cards: b } = await issue(f, extra.id);
    assert.deepEqual([numbers(a), numbers(b)], [['013205', '023205'], ['033205', '043205']]);
    assert.deepEqual(b.map(c => c.person_no), [1, 2]);
    // The Sheet raises the first stay's PAX after the extra cards were printed: the new card continues after 04.
    f.db.prepare('UPDATE tours SET pax=3 WHERE id=?').run(first.id);
    const { cards: c } = await issue(f, first.id);
    assert.deepEqual([numbers(c), c[0].person_no], [['053205'], 3]);
    // The same tour back next month starts again at 01.
    const later = await tour(f, 2, { office: '', arrival: '2026-11-21', departure: '2026-11-23' }), { cards: d } = await issue(f, later.id);
    assert.deepEqual(numbers(d), ['013205', '023205']);
    // 01 now means the guest of whichever stay covers the day.
    f.setTime('2026-10-22T10:00:00Z');
    assert.equal((await typed(f, '013205')).body.person_id, a[0].person_id);
    assert.equal((await typed(f, '043205')).body.person_id, b[1].person_id);
    f.setTime('2026-11-22T10:00:00Z');
    const now = await typed(f, '013205');
    assert.deepEqual([now.body.person_id, now.body.reason], [d[0].person_id, 'admitted']);
    // Between the visits the nearest stay answers, so the gate sees why the guest cannot eat.
    f.setTime('2026-10-25T10:00:00Z');
    assert.deepEqual([(await typed(f, '013205')).body.person_id, (await typed(f, '013205')).body.reason], [a[0].person_id, 'after_departure']);
    f.setTime('2026-11-19T10:00:00Z');
    assert.deepEqual([(await typed(f, '013205')).body.person_id, (await typed(f, '013205')).body.reason], [d[0].person_id, 'before_arrival']);
    // Numbers with two stays covering the day cannot happen through printing; if dates are moved over another stay,
    // the gate is told to scan the QR rather than guessing.
    f.db.prepare('UPDATE tours SET arrival=?,departure=? WHERE id=?').run('2026-10-21', '2026-11-30', later.id);
    f.setTime('2026-10-22T10:00:00Z');
    const both = await typed(f, '013205');
    assert.deepEqual([both.body.reason, both.body.status, both.body.message], ['ambiguous_number', 'red', 'This number matches more than one guest. Scan the QR code']);
  } finally { f.close(); }
});

test('the database refuses a second card with the same number in overlapping stays', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 2); await issue(f, t.id);
    const other = await tour(f, 1, { office: '', arrival: '2026-10-22', departure: '2026-10-25' });
    // As if another computer printed the same number at the same moment.
    assert.throws(() => f.db.prepare("INSERT INTO people(id,tour_id,person_no,sticker_no,sticker_tour) VALUES('x',?,1,2,'3205')").run(other.id), /duplicate_sticker_no/);
    // A stay of the same tour number that does not overlap may reuse it, and so may another tour number.
    const later = await tour(f, 1, { office: '', arrival: '2026-11-01', departure: '2026-11-02' });
    f.db.prepare("INSERT INTO people(id,tour_id,person_no,sticker_no,sticker_tour) VALUES('y',?,1,2,'3205')").run(later.id);
    f.db.prepare("INSERT INTO people(id,tour_id,person_no,sticker_no,sticker_tour) VALUES('z',?,1,2,'9999')").run(other.id);
  } finally { f.close(); }
});

test('a tour ID that is not a tour number prints no card number and cannot be typed', async () => {
  const f = await fixture(); try {
    f.db.prepare("INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,created_at) VALUES('named','MAIMOON TOUR','A','2026-10-21','2026-10-23',1,'sheets','x')").run();
    const { cards } = await issue(f, 'named');
    assert.deepEqual([cards[0].sticker_no, cards[0].sticker_tour, numbers(cards)], [null, null, ['']]);
    assert.equal((await scan(f, cards[0].token)).body.status, 'green');
  } finally { f.close(); }
});

test('a number typed on an offline phone is sent later and checked as at the time it was typed', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 2), { cards } = await issue(f, t.id); f.setTime('2026-10-21T10:00:00Z');
    const key = randomUUID(), sent = await typed(f, '023205', { requestKey: key, offlineAt: '2026-10-21T04:10:00Z', offlineStatus: 'green', gate: 'men' });
    assert.deepEqual([sent.body.reason, sent.body.meal, sent.body.offline, sent.body.person_id, sent.body.typed_code], ['admitted', 'breakfast', 1, cards[1].person_id, '023205']);
    assert.equal((await typed(f, '023205', { requestKey: key, offlineAt: '2026-10-21T04:10:00Z', offlineStatus: 'green' })).body.replayed, true);
    assert.equal((await typed(f, '013205', { offlineAt: '2026-10-21T04:15:00Z', offlineStatus: 'red' })).body.reason, 'offline_declined');
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM admissions WHERE meal='breakfast'").get().n, 1);
  } finally { f.close(); }
});

// Cards printed before card numbers existed have no number under the QR; staff typed 01 and the tour number, which is
// guest 01's card, so it showed ALREADY SCANNED while the card in hand went green by QR. Only the tour number is typed now.
test('a card with no number is checked by its tour number, capped at PAX, and its own QR still goes green later', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 3), { cards } = await issue(f, t.id), meals = () => f.db.prepare("SELECT p.person_no,a.by_tour FROM admissions a JOIN people p ON p.id=a.person_id WHERE a.meal='lunch' ORDER BY p.person_no").all().map(r => [r.person_no, r.by_tour]);
    f.setTime('2026-10-21T10:00:00Z');
    // Each tour number typed counts one guest who has not eaten, highest card number first.
    const first = await typed(f, '3205', { gate: 'women' });
    assert.deepEqual([first.body.status, first.body.reason, first.body.by_tour, first.body.person_no, first.body.typed_code, first.body.message],
      ['green', 'admitted', 1, 3, '3205', 'Welcome — meal allowed']);
    assert.equal((await typed(f, '26/3205')).body.person_no, 2, 'with the year too');
    assert.deepEqual(meals(), [[2, 1], [3, 1]]);
    // Guest 03's own card is not turned away: the tour-number meal moves to guest 01, who has not eaten.
    const own = await scan(f, cards[2].token);
    assert.deepEqual([own.body.status, own.body.reason], ['green', 'admitted']);
    assert.deepEqual(meals(), [[1, 1], [2, 1], [3, 0]]);
    // Every guest has now been counted: the tour number is red, and so is any card of the tour, never more than PAX.
    const full = await typed(f, '3205');
    assert.deepEqual([full.body.status, full.body.reason, full.body.message, full.body.by_tour], ['red', 'tour_full', 'Every guest of this tour has already had this meal', 1]);
    for (const card of [cards[0], cards[1], cards[2]]) assert.equal((await scan(f, card.token)).body.reason, 'already_scanned');
    assert.equal((await typed(f, '013205')).body.reason, 'already_scanned', 'a full card number is still that guest’s card');
    assert.equal(f.db.prepare("SELECT lunch FROM daily_scan_counts WHERE date='2026-10-21'").get().lunch, 3);
    // A tour number with no stay today is unknown; one that is also a card number is checked as the card.
    assert.equal((await typed(f, '9999')).body.reason, 'unknown_number');
    // Breakfast lets everyone in and counts each guest once.
    f.setTime('2026-10-22T04:00:00Z');
    const breakfast = [];for (let i = 0; i < 4; i++) breakfast.push((await typed(f, '3205')).body);
    assert.deepEqual(breakfast.map(b => [b.status, b.reason]), [['green', 'admitted'], ['green', 'admitted'], ['green', 'admitted'], ['green', 'breakfast_repeat']]);
    assert.equal(f.db.prepare("SELECT breakfast FROM daily_scan_counts WHERE date='2026-10-22'").get().breakfast, 3);
    // After the stay the tour number matches nobody.
    f.setTime('2026-10-24T10:00:00Z');
    assert.equal((await typed(f, '3205')).body.reason, 'unknown_number');
    // The scan log and archive tell a tour number from a card number.
    const log = (await f.admin.get('/api/logs?date=2026-10-21').expect(200)).body;
    assert.deepEqual(log.filter(r => r.by_tour).map(r => [r.typed_code, r.reason]).reverse(), [['3205', 'admitted'], ['26/3205', 'admitted'], ['3205', 'tour_full']]);
    assert.equal(log.find(r => r.typed_code === '9999').by_tour, null, 'a tour number nobody is staying under is just unknown');
  } finally { f.close(); }
});

test('a tour number reaches only staying guests of that tour number within PAX, across stays under the same tour ID', async () => {
  const f = await fixture(); try {
    const t = await tour(f, 2), { cards } = await issue(f, t.id);
    // Lost cards added under the same tour ID while it is staying continue the numbers (guest 03), and count as the tour.
    const extra = (await f.admin.post('/api/tours').send({ tour_id: '26/3205', pax: 1, arrival: '2026-10-21', departure: '2026-10-21' }).expect(201)).body;
    const added = (await issue(f, extra.id)).cards;
    assert.deepEqual(numbers(added), ['033205']);
    f.setTime('2026-10-21T10:00:00Z');
    const picked = [];for (let i = 0; i < 3; i++) picked.push((await typed(f, '3205')).body.person_id);
    assert.deepEqual(picked, [added[0].person_id, cards[1].person_id, cards[0].person_id]);
    assert.equal((await typed(f, '3205')).body.reason, 'tour_full');
    // The next day the added one-day stay has ended, so only the two guests of the main stay remain.
    f.setTime('2026-10-22T10:00:00Z');
    const next = [];for (let i = 0; i < 3; i++) next.push((await typed(f, '3205')).body.reason);
    assert.deepEqual(next, ['admitted', 'admitted', 'tour_full']);
  } finally { f.close(); }
});
