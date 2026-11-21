import test from 'node:test';
import assert from 'node:assert/strict';
import { visitsFromRows, nkerpArrivals, readVisits, addDays, VISIT_LISTS, storedMoves } from '../src/nkerp.js';

// Rows shaped like NKERP's Karbala visit lists (live examples from November 2026, trimmed).
export const row = (ref, arrival, departure, extra = {}) => ({ Id: Math.floor(Math.random() * 1e9), TourId: Number(ref.split('/').pop()) + 428000000,
  ArrivalDate: arrival, DepartureDate: departure, Tour: { ReferenceNo: `NKERP/TOUR/2026/${ref.split('/').pop()}`, PaxCount: 2 }, ...extra });

test('NKERP rows become [tour ID, Karbala arrival time, departure date], deduplicated and sorted', () => {
  const rows = [row('2291', '2026-11-20T20:45:00', '2026-11-25T08:00:00'), row('2291', '2026-11-20T20:45:00', '2026-11-25T08:00:00'),
    row('3389', '2026-11-20T00:35:00', '2026-11-29T08:00:00'), { ArrivalDate: '2026-11-20T10:00:00', DepartureDate: '2026-11-21T10:00:00', Tour: { ReferenceNo: 'other' } },
    row('1', null, '2026-11-25T08:00:00'), row('2', '2026-11-25T08:00:00', '2026-11-20T08:00:00')];
  assert.deepEqual(visitsFromRows(rows), [['26/2291', '2026-11-20T20:45', '2026-11-25'], ['26/3389', '2026-11-20T00:35', '2026-11-29']]);
});

test('A tour that reached Karbala the evening before its Pehli starts its stay on the arrival day', () => {
  const visits = [['26/2291', '2026-11-20T20:45', '2026-11-25'], ['26/3389', '2026-11-20T00:35', '2026-11-29'], ['26/3709', '2026-11-10T11:00', '2026-11-23'],
    ['26/3449', '2026-11-19T15:10', '2026-11-24'], ['26/5000', '2026-11-08T20:00', '2026-11-12'], ['26/7000', '2026-11-18T21:00', '2026-11-25']];
  const sheet = [
    { tour_id: '26/2291', office: 'A', arrival: '2026-11-21', departure: '2026-11-25', pax: 10 }, // late arrival on the next day's Pehli
    { tour_id: '26/3389', office: 'B', arrival: '2026-11-20', departure: '2026-11-29', pax: 5 }, // after midnight: same day, unchanged
    { tour_id: '26/3709', office: 'C', arrival: '2026-11-18', departure: '2026-11-23', pax: 1 }, // eight days: not this case, unchanged
    { tour_id: '26/3449', office: 'D', arrival: '2026-11-17', departure: '2026-11-24', pax: 6 }, // NKERP later: never moved later
    { tour_id: '26/5000', office: 'E', arrival: '2026-11-20', departure: '2026-11-25', pax: 1 }, // NKERP visit is an earlier stay
    { tour_id: '7000', office: 'F', arrival: '2026-11-20', departure: '2026-11-25', pax: 1 }, // Sheet ID without its year; two days
    { tour_id: '26/9999', office: 'G', arrival: '2026-11-21', departure: '2026-11-25', pax: 1 }]; // not in NKERP
  const out = nkerpArrivals(sheet, visits);
  assert.deepEqual(out.map(t => [t.tour_id, t.arrival, t.sheet_arrival || null]), [['26/2291', '2026-11-20', '2026-11-21'], ['26/3389', '2026-11-20', null],
    ['26/3709', '2026-11-18', null], ['26/3449', '2026-11-17', null], ['26/5000', '2026-11-20', null], ['7000', '2026-11-18', '2026-11-20'], ['26/9999', '2026-11-21', null]]);
  assert.equal(out[0].arrived, '2026-11-20T20:45');
  assert.equal(out[0].departure, '2026-11-25');
  // A second Sheet stay of the same tour that would overlap the moved arrival keeps its Pehli.
  const repeat = nkerpArrivals([{ ...sheet[0], arrival: '2026-11-15', departure: '2026-11-20' }, sheet[0]], visits);
  assert.deepEqual(repeat.map(t => t.arrival), ['2026-11-15', '2026-11-21']);
  assert.deepEqual(nkerpArrivals(sheet, undefined), sheet);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// A fake NKERP: sign-in, the section call and the four visit lists, with paging.
function fakeNkerp({ rows = {}, role = '13,74' } = {}) {
  const calls = [];
  let sessions = 0;
  const fetcher = async (url, init) => {
    const path = url.replace('https://to.najafkarbala.com/NKERPApi/', ''), body = init.body ? JSON.parse(init.body) : null, cookie = init.headers.Cookie || '';
    calls.push({ path, body, cookie });
    if (path === 'api/accounts/Login') {
      sessions++;
      const ok = body.LoginId === 'id' && body.Password === 'pw';
      return Response.json(ok ? { ReturnStatus: true, IsAuthenicated: true, UserId: 77, Role: role } : { ReturnStatus: false }, { headers: [['Set-Cookie', `.ASPXAUTH=s${sessions}; path=/; HttpOnly`], ['Set-Cookie', 'ASP.NET_SessionId=x; path=/']] });
    }
    // Only sessions this fake signed in are accepted; an old one has expired.
    if (!/\.ASPXAUTH=s\d/.test(cookie)) return new Response('expired', { status: 401 });
    if (path.startsWith('api/user/GetSectionIdByGroupId/')) return Response.json({});
    const list = rows[path] || [], start = (body.currentPage - 1) * body.itemsPerPage;
    return Response.json({ lstMufiquaFinalInZSDTO: list.slice(start, start + body.itemsPerPage), TotalRows: list.length });
  };
  return { fetcher, calls };
}

test('readVisits signs in, reads every page of all four Karbala lists, and keeps the session', async () => {
  const many = Array.from({ length: 150 }, (_, i) => row(String(3000 + i), '2026-11-20T21:05:00', '2026-11-25T08:00:00'));
  const nk = fakeNkerp({ rows: { [VISIT_LISTS[0]]: many, [VISIT_LISTS[3]]: [row('2291', '2026-11-20T20:45:00', '2026-11-25T08:00:00')] } });
  const read = await readVisits({ loginId: 'id', password: 'pw', today: '2026-11-21', fetcher: nk.fetcher });
  assert.equal(read.visits.length, 151);
  assert.deepEqual([read.from, read.to], ['2026-10-07', '2026-12-21']);
  assert.deepEqual(nk.calls.map(c => c.path), ['api/accounts/Login', 'api/user/GetSectionIdByGroupId/13', VISIT_LISTS[0], VISIT_LISTS[0], ...VISIT_LISTS.slice(1)]);
  const search = nk.calls[2];
  assert.equal(search.body.IsZiyaratRequired, false);assert.equal(search.body.subVenueSearchId, 4);assert.equal(search.body.TOId, 77);assert.equal(search.body.FromDateFromSearch, '2026-10-07');
  assert.match(search.cookie, /\.ASPXAUTH=s1/);assert.match(search.cookie, /GroupId=13/);assert.match(search.cookie, /UserId=77/);
  // The next run reuses the session: no sign-in.
  const again = await readVisits({ loginId: 'id', password: 'pw', session: read.session, today: '2026-11-21', fetcher: nk.fetcher });
  assert.equal(again.visits.length, 151);
  assert.equal(nk.calls.filter(c => c.path === 'api/accounts/Login').length, 1);
});

test('readVisits signs in again once when the kept session has expired, and reports a failed sign-in', async () => {
  const nk = fakeNkerp({ rows: { [VISIT_LISTS[0]]: [row('2291', '2026-11-20T20:45:00', '2026-11-25T08:00:00')] } });
  const stale = { cookies: [['.ASPXAUTH', 'old'], ['GroupId', '13'], ['UserId', '77']], userId: 77 };
  const read = await readVisits({ loginId: 'id', password: 'pw', session: stale, today: '2026-11-21', fetcher: nk.fetcher });
  assert.deepEqual(read.visits, [['26/2291', '2026-11-20T20:45', '2026-11-25']]);
  assert.deepEqual(nk.calls.map(c => c.path).slice(0, 3), [VISIT_LISTS[0], 'api/accounts/Login', 'api/user/GetSectionIdByGroupId/13']);
  assert.ok(read.session.cookies.some(([k, v]) => k === '.ASPXAUTH' && v === 's1'));
  await assert.rejects(readVisits({ loginId: 'id', password: 'wrong', today: '2026-11-21', fetcher: fakeNkerp().fetcher }), /sign-in failed/);
  await assert.rejects(readVisits({ loginId: 'id', password: 'pw', today: '2026-11-21', fetcher: fakeNkerp({ role: '74' }).fetcher }), /Karbala Ziyarat role/);
});

test('readVisits refuses an incomplete census instead of storing part of the visits', async () => {
  const nk = fakeNkerp();
  const short = async (url, init) => {
    const res = await nk.fetcher(url, init);
    if (!url.includes('VisitingPoint')) return res;
    return Response.json({ lstMufiquaFinalInZSDTO: [], TotalRows: 3 });
  };
  await assert.rejects(readVisits({ loginId: 'id', password: 'pw', today: '2026-11-21', fetcher: short }), /part-way/);
});

test('storedMoves uses the Sheet arrival kept in each stay\'s source key and only moves stays earlier', () => {
  const key = arrival => `sheet|Tours|26/2291|${arrival}`;
  const visits = [['26/2291', '2026-11-20T20:45', '2026-11-25'], ['26/3545', '2026-11-20T21:05', '2026-11-25']];
  const rows = [{ id: 'a', tour_id: '26/2291', arrival: '2026-11-21', departure: '2026-11-25', source_key: key('2026-11-21') },
    { id: 'b', tour_id: '26/3545', arrival: '2026-11-20', departure: '2026-11-25', source_key: 'sheet|Tours|26/3545|2026-11-21' }, // already moved
    { id: 'c', tour_id: '26/3545', arrival: '2026-11-18', departure: '2026-11-19', source_key: 'manual' }]; // no Sheet arrival
  assert.deepEqual(storedMoves(rows, visits), [{ id: 'a', tour_id: '26/2291', from: '2026-11-21', to: '2026-11-20', arrived: '2026-11-20T20:45' }]);
  // A stay with printed cards already widened before its arrival keeps its earlier day.
  assert.deepEqual(storedMoves([{ ...rows[0], arrival: '2026-11-19' }], visits), []);
});
