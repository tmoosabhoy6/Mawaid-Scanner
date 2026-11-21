// Actual Karbala arrival days from NKERP.
// The Karbala Ziyarat Sheet places a tour that reaches Karbala in the afternoon or at night on the NEXT day's Pehli
// Ziyarat. The Sheet sync takes Pehli as the arrival, so those guests' cards said they arrive tomorrow and turned
// red at that evening's dinner. NKERP's Karbala visit lists hold the actual arrival time of every visit. The Worker
// reads them every ten minutes (read-only: it signs in and reads the four Karbala visit lists, nothing else), and
// the Sheet sync moves such a stay's arrival back to the day NKERP gives. The Sheet keeps everything else: names,
// PAX and the departure (Wada + 1 day).
import { bareTourId } from './rules.js';

export const NKERP = { base: 'https://to.najafkarbala.com/NKERPApi/', origin: 'https://to.najafkarbala.com',
  role: 13 /* Ziyarat Incharge of KARBALA */, venue: 2 /* IRAQ */, subvenue: 4 /* KARBALA */ };
// Every Karbala visit, whatever its Ziyarat schedule state.
export const VISIT_LISTS = ['api/VisitingPoint/getReleasedTours', 'api/VisitingPoint/getScheduledTours',
  'api/VisitingPoint/getPartialScheduledTours', 'api/VisitingPoint/MuwafiqaApprovedTours'];
const ROW_KEYS = ['lstMufiquaFinalInZSDTO', 'lstMufiquaInZSDTO'];
// A late arrival is placed on the next day's Pehli; allow one spare day. A larger gap is not this case and is left
// to the Sheet.
export const MAX_EARLIER_DAYS = 2;
// Arrivals read: from this many days ago (long stays still current) to this many days ahead.
export const WINDOW = { before: 45, after: 30 };
const PAGE = 100, MAX_PAGES = 60;

export const addDays = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);
const localStamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

// One entry per Karbala visit: [tour ID as the Sheet writes it, arrival in Karbala time (YYYY-MM-DDTHH:mm),
// departure date]. NKERP's ArrivalDate and DepartureDate on these lists are already Karbala local time.
export function visitsFromRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const ref = /^NKERP\/TOUR\/20(\d{2})\/(\d{1,6})$/.exec(String(row?.Tour?.ReferenceNo || '').trim());
    const arrived = localStamp.exec(String(row?.ArrivalDate || '')), departed = localStamp.exec(String(row?.DepartureDate || ''));
    if (!ref || !arrived || !departed || departed[1] < arrived[1]) continue;
    const visit = [`${ref[1]}/${ref[2]}`, `${arrived[1]}T${arrived[2]}`, departed[1]];
    seen.set(visit.join('|'), visit);
  }
  return [...seen.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
}

// The Sheet's stays, with the arrival moved back to NKERP's Karbala arrival day where the Sheet has the tour on a
// later Pehli. Only a gap of up to MAX_EARLIER_DAYS within the same stay counts (NKERP's departure is on or after
// the Sheet's arrival), and never into an earlier stay of the same tour. A moved stay keeps the Sheet's arrival in
// sheet_arrival, which keeps its source key. Arrivals are only ever moved earlier.
export function nkerpArrivals(tours, visits) {
  const byTour = new Map();
  for (const [id, arrived, departure] of visits || []) {
    for (const key of [id, bareTourId(id)]) { if (!byTour.has(key)) byTour.set(key, []); byTour.get(key).push({ arrival: arrived.slice(0, 10), arrived, departure }); }
  }
  return tours.map(tour => {
    const own = byTour.get(tour.tour_id.includes('/') ? tour.tour_id : bareTourId(tour.tour_id)) || [], earliest = addDays(tour.arrival, -MAX_EARLIER_DAYS);
    const match = own.filter(v => v.arrival < tour.arrival && v.arrival >= earliest && v.departure >= tour.arrival).sort((a, b) => b.arrival.localeCompare(a.arrival))[0];
    if (!match || tours.some(o => o !== tour && o.tour_id === tour.tour_id && o.arrival < tour.arrival && o.departure >= match.arrival)) return tour;
    return { ...tour, arrival: match.arrival, sheet_arrival: tour.arrival, arrived: match.arrived };
  });
}

const cookieHeader = jar => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(jar, response) {
  const lines = response.headers.getSetCookie?.() || [];
  for (const line of lines) {
    const [pair, ...attrs] = line.split(';'), at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
    const expired = attrs.some(a => /^\s*max-age=0\s*$/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now()));
    if (!value || expired) jar.delete(name); else jar.set(name, value);
  }
}

// Reads every Karbala visit arriving in the window. A session from an earlier run is reused; if it no longer works
// the account signs in again once. Returns the visits and the session to keep for the next run.
export async function readVisits({ loginId, password, session = null, today, fetcher = fetch }) {
  const from = addDays(today, -WINDOW.before), to = addDays(today, WINDOW.after);
  const attempt = async reuse => {
    const jar = new Map(reuse?.cookies || []);
    let userId = reuse?.userId ?? null;
    const call = async (path, body) => {
      const response = await fetcher(NKERP.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: NKERP.origin, Referer: NKERP.origin + '/', ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      keepCookies(jar, response);
      if (!response.ok) throw new Error(`NKERP answered HTTP ${response.status}.`);
      let data; try { data = await response.json(); } catch { throw new Error('NKERP did not answer with data.'); }
      if (data?.IsError) throw new Error('NKERP refused the request.');
      return data;
    };
    if (!reuse) {
      // Only Login sets IsAuthenicated; every other answer leaves it false.
      const login = await call('api/accounts/Login', { LocalUTCTime: new Date().toISOString(), LoginId: loginId, Password: password });
      if (!login?.ReturnStatus || !login?.IsAuthenicated || !login.UserId) throw new Error('NKERP sign-in failed. Check NKERP_LOGIN_ID and NKERP_PASSWORD.');
      if (!String(login.Role || '').split(',').map(r => r.trim()).includes(String(NKERP.role))) throw new Error('This NKERP account does not have the Karbala Ziyarat role.');
      userId = login.UserId;
      await call(`api/user/GetSectionIdByGroupId/${NKERP.role}`);
      jar.set('GroupId', String(NKERP.role)); jar.set('UserId', String(userId));
    }
    const rows = [];
    for (const list of VISIT_LISTS) {
      const seen = new Set();
      let total = null;
      for (let page = 1; total === null || seen.size < total; page++) {
        if (page > MAX_PAGES) throw new Error('NKERP returned more pages than expected.');
        // IsZiyaratRequired false lists the visits that need Ziyarat (NKERP's filter is inverted).
        const data = await call(list, { IsZiyaratRequired: false, PackageId: null, TOId: userId, TOOfficeNameSearch: null,
          FromDateFromSearch: from, FromDateToSearch: to, TourSearchRefNo: null, ZiyaratGroupId: null, clientTimeZoneOffset: -180,
          currentPage: page, ddlSubVenue: { Value: NKERP.subvenue, Text: 'KARBALA' }, group: NKERP.role, itemsPerPage: PAGE, maxSize: PAGE,
          reverse: false, sortBy: 'ModifiedOn', totalItems: PAGE, subVenueSearchId: NKERP.subvenue, venueSearchId: NKERP.venue });
        const chunk = ROW_KEYS.flatMap(k => Array.isArray(data?.[k]) ? data[k] : []);
        total = Number.isInteger(data?.TotalRows) ? data.TotalRows : seen.size + chunk.length;
        if (!chunk.length) { if (seen.size < total) throw new Error('NKERP stopped listing visits part-way; tried again next run.'); break; }
        for (const row of chunk) { const key = `${row.TourId}|${row.TourSubVenuePlanId ?? row.Id}`; if (!seen.has(key)) { seen.add(key); rows.push(row); } }
      }
    }
    return { visits: visitsFromRows(rows), session: { cookies: [...jar], userId }, from, to };
  };
  if (session) { try { return await attempt(session); } catch { /* expired or refused: sign in again below */ } }
  return attempt(null);
}
