import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash, timingSafeEqual, scryptSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openDatabase, transaction } from './db.js';
import { serviceAt, validateTour, validateSafari, validateExtension, bareTourId, SAME_TOUR_SQL, TIME_ZONE, START_DATE } from './rules.js';
import { makeLabels } from './labels.js';
import { tourList, safariList, scanLogQuery, BATCH_LIST_SQL } from './list-queries.js';
import { SUMMARY_SQL, TOUR_REPORT_SQL, EXTENSIONS_SQL } from './summary.js';
import { SCAN_SQL, FIRST_ADMISSION_SQL, SCAN_REASONS as reasons, offlineTime } from './scan-query.js';
import { offlineData } from './offline.js';
import { ARCHIVE_DATASETS, archiveSql, archiveCutoff, archivePage, CLEAR_ROWS, CLEAR_PDFS } from './archive.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const x = hash(a), y = hash(b); return timingSafeEqual(Buffer.from(x), Buffer.from(y)); };
const uid = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function createApp(options = {}) {
  const config = { origin: process.env.APP_ORIGIN || 'http://localhost:3000',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    syncToken: process.env.SYNC_TOKEN || '', dataDir: resolve(process.env.DATA_DIR || '.data'), ...options };
  if (!config.adminPassword || config.syncToken.length < 32) throw new Error('Set ADMIN_PASSWORD and SYNC_TOKEN (32+ characters).');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(origin.hostname)) throw new Error('APP_ORIGIN must use HTTPS outside localhost.');
  const db = options.db || openDatabase(join(config.dataDir, 'mawayid.sqlite'));
  const now = options.now || (() => new Date());
  const app = express(); app.locals.db = db;
  app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'wss://localhost:*', 'ws://localhost:*'],
    mediaSrc: ["'self'", 'blob:'], frameSrc: ["'self'", 'blob:'], objectSrc: ["'none'"], upgradeInsecureRequests: origin.protocol === 'https:' ? [] : null,
  } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '3mb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== origin.origin) return res.status(403).json({ error: 'Unexpected request origin.' });
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site request rejected.' });
    next();
  });
  const getSetting = (key, fallback) => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; };
  const setSetting = (key, value) => db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const printer = () => getSetting('printer', { widthMm: 76.2, heightMm: 50.8, name: 'ZDesigner ZD220-203dpi ZPL', confirmed: true });
  const source = () => getSetting('source', { spreadsheetId: '12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE', tab: 'Tours', dailyTimes: [] });
  // Only the administrator signs in. The scanner needs no session; older scanner sessions no longer count.
  const auth = (req, res, next) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('mawayid_session='))?.slice(16);
    const session = raw && db.prepare("SELECT role FROM sessions WHERE hash=? AND expires>? AND role='admin'").get(hash(raw), Date.now());
    if (!session) return res.status(401).json({ error: 'Please sign in.' });
    next();
  };
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const salt = randomBytes(16);
  const adminHash = scryptSync(config.adminPassword, salt, 32);
  app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.post('/api/login', loginLimit, (req, res) => {
    if (typeof req.body.password !== 'string' || req.body.password.length > 256 || !timingSafeEqual(scryptSync(req.body.password, salt, 32), adminHash)) return res.status(401).json({ error: 'Incorrect password.' });
    const session = token(); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), 'admin', Date.now() + 12 * 60 * 60 * 1000);
    res.cookie('mawayid_session', session, { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000, path: '/' });
    res.json({ role: 'admin' });
  });
  app.post('/api/logout', auth, (req, res) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('mawayid_session='))?.slice(16);
    if (raw) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(raw));
    res.clearCookie('mawayid_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/session', auth, (req, res) => res.json({ role: 'admin' }));
  app.get('/api/service', (req, res) => res.json({ ...serviceAt(now()), serverTime: now().toISOString(), timezone: TIME_ZONE, startDate: START_DATE }));
  app.get('/api/tours', auth, (req, res) => {
    const arrival = String(req.query.arrival || ''), q = String(req.query.q || '').slice(0,150), sort = String(req.query.sort || ''), status = String(req.query.status || '');
    const query = tourList({ arrival, q: q.toLowerCase(), sort, status });
    const rows = db.prepare(query.sql).all(...query.params);
    res.json(rows);
  });
  app.post('/api/tours', auth, (req, res) => {
    let t; try { t = validateTour(req.body, { requireId: false }); } catch (e) { throw fail(e.message); }
    // Reusing a tour ID for the same stay returns the existing entitlement instead of adding seats.
    const existing = t.tour_id && db.prepare(SAME_TOUR_SQL).get(bareTourId(t.tour_id), t.arrival, t.departure, t.tour_id);
    if (existing) return res.json({ ...existing, existing: true });
    const id = uid(); db.prepare('INSERT INTO tours(id,tour_id,its,office,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, t.tour_id, t.its, t.office, t.arrival, t.departure, t.pax, now().toISOString());
    res.status(201).json({ id, ...t });
  });
  // Safari cards print without a QR code, so they have no people, cards or scans.
  app.get('/api/safaris', auth, (req, res) => {
    const arrival = req.query.arrival || '', q = req.query.q || '', sort = String(req.query.sort || ''), status = String(req.query.status || '');
    const query = safariList({ arrival, q: q.toLowerCase(), sort, status });
    res.json(db.prepare(query.sql).all(...query.params));
  });
  app.post('/api/safaris', auth, (req, res) => {
    let s; try { s = validateSafari(req.body); } catch (e) { throw fail(e.message); }
    const row = { id: uid(), ...s, created_at: now().toISOString() };
    db.prepare('INSERT INTO safaris(id,office,tour_id,its,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));
    res.status(201).json(row);
  });
  // The printing computer draws Safari stickers and saves the PDF here before printing, so the job appears in Print log.
  app.post('/api/safaris/print', auth, express.raw({ type: 'application/pdf', limit: '3mb' }), (req, res) => {
    const key = req.query.requestKey, ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))];
    if (typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) throw fail('A valid request key is required.');
    if (!ids.length || ids.length > 100 || ids.some(id => !/^[\w-]{1,100}$/.test(id))) throw fail('Select up to 100 Safari cards per print job.');
    const prior = db.prepare('SELECT id FROM batches WHERE request_key=?').get(key); if (prior) return res.json({ id: prior.id, existing: true });
    const pdf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (pdf.subarray(0, 5).toString() !== '%PDF-' || !pdf.subarray(-100).toString().includes('%%EOF')) throw fail('Upload a generated PDF.');
    if (db.prepare('SELECT COUNT(*) AS n FROM safaris WHERE id IN (SELECT value FROM json_each(?))').get(JSON.stringify(ids)).n !== ids.length) throw fail('Safari card not found.', 404);
    const id = uid();
    transaction(db, () => {
      db.prepare("INSERT INTO batches(id,created_at,kind,request_key,pdf) VALUES(?,?,'safari',?,?)").run(id, now().toISOString(), key, pdf);
      for (const safari of ids) db.prepare('INSERT INTO safari_prints VALUES(?,?)').run(id, safari);
    });
    res.status(201).json({ id, count: ids.length });
  });
  // Extending a stay adds meals after departure on the same QR cards; changes keep their history.
  app.get('/api/tours/:id/extensions', auth, (req, res) => res.json(db.prepare(EXTENSIONS_SQL).all(req.params.id)));
  app.post('/api/tours/:id/extensions', auth, (req, res) => {
    const tour = db.prepare('SELECT id,departure,active FROM tours WHERE id=?').get(req.params.id);
    let x; try { x = validateExtension(req.body, tour, serviceAt(now()).date); } catch (e) { throw fail(e.message, e.status); }
    const stamp = now().toISOString(), row = { id: uid(), tour_id: tour.id, date: x.date, meals: x.meals, created_at: stamp };
    const current = db.prepare('SELECT * FROM tour_extensions WHERE tour_id=? AND date=? AND removed_at IS NULL').get(tour.id, x.date);
    if (current?.meals === x.meals) return res.json({ ...current, existing: true });
    transaction(db, () => {
      db.prepare('UPDATE tour_extensions SET removed_at=? WHERE tour_id=? AND date=? AND removed_at IS NULL').run(stamp, tour.id, x.date);
      db.prepare('INSERT INTO tour_extensions(id,tour_id,date,meals,created_at) VALUES(?,?,?,?,?)').run(...Object.values(row));
    });
    res.status(201).json(row);
  });
  app.post('/api/extensions/:id/remove', auth, (req, res) => {
    if (!db.prepare('UPDATE tour_extensions SET removed_at=? WHERE id=? AND removed_at IS NULL').run(now().toISOString(), req.params.id).changes) throw fail('This extension was already removed.', 404);
    res.json({ ok: true });
  });
  app.get('/api/tours/:id/people', auth, (req, res) => res.json(db.prepare(`SELECT p.id,p.person_no,c.id AS card_id,c.created_at FROM people p LEFT JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL WHERE p.tour_id=? ORDER BY p.person_no`).all(req.params.id)));
  app.post('/api/labels', auth, async (req, res) => {
    if (typeof req.body.requestKey !== 'string' || !/^[\w-]{16,100}$/.test(req.body.requestKey)) throw fail('A valid request key is required.');
    const prior = db.prepare('SELECT id FROM batches WHERE request_key=?').get(req.body.requestKey);
    if (prior) return res.json({ id: prior.id, existing: true });
    const settings = printer(); if (!settings.confirmed) throw fail('Confirm your label dimensions in Settings before printing.');
    const mode = req.body.personIds ? 'replacement' : 'initial';
    const selected = mode === 'replacement' ? req.body.personIds : req.body.tourIds;
    if (!Array.isArray(selected)) throw fail('Select tours or people.');
    const ids = [...new Set(selected)];
    if (!ids.length || ids.some(id => typeof id !== 'string')) throw fail('Select tours or people.');
    if (ids.length > 500) throw fail('Print up to 500 people per batch; there is no lifetime replacement limit.');
    const batchId = uid(), stamp = now().toISOString(); let cards = [];
    for (const id of ids) {
      if (mode === 'replacement') {
        const person = db.prepare('SELECT p.id AS person_id,p.person_no,t.* FROM people p JOIN tours t ON t.id=p.tour_id WHERE p.id=?').get(id);
        if (!person) throw fail('Person not found.', 404);
        const oldCard = db.prepare('SELECT id FROM cards WHERE person_id=? AND revoked_at IS NULL').get(id);
        if (!oldCard) throw fail('This person has no active card.',409);
        // The replacement list records each card it showed; a card replaced since then is not replaced twice.
        if (req.body.expectedCardIds?.[id] !== oldCard.id) throw fail('This card changed since the replacement list was opened. Refresh it before trying again.', 409);
        if (!person.active) throw fail('This source tour is no longer active.');
        if (person.person_no > person.pax) throw fail('Person exceeds the current tour PAX.');
        cards.push({ ...person, id: uid(), person_id: id, tour_key: person.id, previous_card: oldCard.id, token: token(), printed_at: stamp });
      } else {
        const tour = db.prepare('SELECT * FROM tours WHERE id=?').get(id); if (!tour) throw fail('Tour not found.', 404);
        if (!tour.active) throw fail('This source tour is no longer active.');
        const count = db.prepare('SELECT COUNT(*) AS n FROM people WHERE tour_id=?').get(id).n;
        for (let n = count + 1; n <= tour.pax && cards.length < 500; n++) cards.push({ ...tour, id: uid(), tour_key: id, person_id: uid(), person_no: n, token: token(), printed_at: stamp });
      }
    }
    if (!cards.length) throw fail('All selected people already have cards. Open the print log to reprint, or replace a lost card.');
    if (cards.length > 500) throw fail('Select a smaller batch (at most 500 labels per job). There is no total card replacement cap.');
    const pdf = await (options.renderLabels || makeLabels)(cards, settings);
    const result = transaction(db, () => {
      const retry = db.prepare('SELECT id FROM batches WHERE request_key=?').get(req.body.requestKey); if (retry) return { id: retry.id, existing: true };
      db.prepare('INSERT INTO batches(id,created_at,kind,request_key,pdf) VALUES(?,?,?,?,?)').run(batchId, stamp, mode, req.body.requestKey, pdf);
      for (const c of cards) {
        if (mode === 'initial') {
          const latest = db.prepare('SELECT pax FROM tours WHERE id=?').get(c.tour_key);
          if (!latest || c.person_no > latest.pax) throw fail('Tour changed while preparing labels. Refresh and try again.', 409);
          db.prepare('INSERT INTO people VALUES(?,?,?)').run(c.person_id, c.tour_key, c.person_no);
        } else {
          const activeCard = db.prepare('SELECT id FROM cards WHERE person_id=? AND revoked_at IS NULL').get(c.person_id);
          if (activeCard?.id !== c.previous_card) throw fail('This card was replaced by another operator. Refresh before trying again.',409);
          db.prepare('UPDATE cards SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL').run(stamp, c.person_id);
        }
        db.prepare('INSERT INTO cards(id,person_id,batch_id,token_hash,created_at) VALUES(?,?,?,?,?)').run(c.id, c.person_id, batchId, hash(c.token), stamp);
      }
      const remaining = mode === 'initial' ? ids.reduce((sum,id)=>sum+Math.max(0,db.prepare('SELECT pax FROM tours WHERE id=?').get(id).pax-db.prepare('SELECT COUNT(*) AS n FROM people WHERE tour_id=?').get(id).n),0) : 0;
      return { id: batchId, count: cards.length, remaining };
    });
    res.status(201).json(result);
  });
  app.get('/api/batches', auth, (req, res) => res.json(db.prepare(BATCH_LIST_SQL).all()));
  app.get('/api/batches/:id/pdf', auth, (req, res) => {
    const batch = db.prepare('SELECT pdf,printer_status FROM batches WHERE id=?').get(req.params.id);
    if (batch?.printer_status === 'pdf_cleared') throw fail('This label PDF was cleared after the stay ended. Use Replace cards if a guest still needs a card.', 410);
    if (!batch?.pdf) throw fail('PDF not found.', 404);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="mawaid-${req.params.id}.pdf"` }).send(Buffer.from(batch.pdf));
  });
  app.post('/api/batches/:id/status', auth, (req, res) => {
    if (!['sent_to_printer','printer_error'].includes(req.body.status)) throw fail('Invalid printer status.');
    db.prepare('UPDATE batches SET printer_status=? WHERE id=? AND pdf IS NOT NULL').run(req.body.status, req.params.id); res.json({ ok: true });
  });
  // Gate phones keep a copy of current cards for checking while the connection is down (see offline.js).
  app.get('/api/scanner/data', async (req, res) => {
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    res.json(await offlineData(all, new URL(req.url, 'http://local'), { ...serviceAt(now()), serverTime: now().toISOString() }, 'hex'));
  });
  app.post('/api/scan', (req, res) => {
    const { requestKey, code } = req.body;
    if (typeof requestKey !== 'string' || !/^[\w-]{16,100}$/.test(requestKey)) throw fail('A scan request key is required.');
    if (typeof code !== 'string' || code.length > 300) throw fail('Invalid QR code.');
    // A scan made on an offline phone is checked as at the time it was made.
    const offlineAt = offlineTime(req.body, now()), at = offlineAt || now(), service = serviceAt(at);
    const codeHash = code.startsWith('MW1:') ? hash(code.slice(4)) : '';
    const result = transaction(db, () => {
      const row = db.prepare(SCAN_SQL).get(requestKey, service.date, at.toISOString(), codeHash, service.meal, offlineAt ? 1 : 0, offlineAt && req.body.offlineStatus === 'red' ? 1 : 0);
      return row ? { ...row } : { ...db.prepare('SELECT * FROM scan_logs WHERE request_key=?').get(requestKey), replayed: true };
    });
    const earlier = result.reason === 'already_scanned' ? db.prepare(FIRST_ADMISSION_SQL).get(result.person_id, result.date, result.meal) : null;
    // A network replay can acknowledge a prior admission but must not show a fresh green gate.
    res.json({ ...result, replayed: !!result.replayed, firstScannedAt: earlier?.scanned_at || null, status: result.reason === 'admitted' && !result.replayed ? 'green' : 'red', message: result.replayed ? 'Request already processed — check the scan log before admitting' : reasons[result.reason], serverTime: now().toISOString() });
  });
  app.get('/api/logs', auth, (req, res) => {
    const { date = '', tour = '', status = '', office = '' } = req.query;
    const query = scanLogQuery({ date, tour: tour.toLowerCase(), office: office.toLowerCase(), status });
    res.json(db.prepare(query.sql).all(...query.params));
  });
  app.get('/api/summary', auth, (req, res) => {
    const date = req.query.date || serviceAt(now()).date;
    res.json(db.prepare(SUMMARY_SQL).get(date));
  });
  app.get('/api/summary/tours', auth, (req, res) => res.json(db.prepare(TOUR_REPORT_SQL).all(String(req.query.date || serviceAt(now()).date))));
  const databaseBytes = () => db.prepare('SELECT page_count*page_size AS n FROM pragma_page_count(),pragma_page_size()').get().n;
  app.get('/api/settings', auth, (req, res) => res.json({ printer: printer(), source: source(), sync: getSetting('sync', null), timeZone: TIME_ZONE, hosting: 'server', databaseBytes: databaseBytes() }));
  const archive = archiveSql(false), cutoff = value => { const today = serviceAt(now()).date; return archiveCutoff(value || today, today); };
  app.get('/api/archive', auth, (req, res) => {
    const before = cutoff(req.query.before);
    res.json({ before, today: serviceAt(now()).date, counts: db.prepare(archive.counts).get(before), databaseBytes: databaseBytes(), cleanup: null });
  });
  app.get('/api/archive/:dataset', auth, (req, res) => {
    const sql = Object.hasOwn(ARCHIVE_DATASETS, req.params.dataset) && ARCHIVE_DATASETS[req.params.dataset]; if (!sql) throw fail('Not found.', 404);
    const before = cutoff(req.query.before), { after, limit } = archivePage(new URL(req.url, 'http://local'));
    const rows = db.prepare(sql).all(before, after, limit);
    res.json({ rows, next: rows.length === limit ? rows.at(-1).cursor : null });
  });
  app.post('/api/archive/clear', auth, (req, res) => {
    const before = archiveCutoff(req.body.before, serviceAt(now()).date);
    const deleted = transaction(db, () => ({ scans: db.prepare(archive.clearScans).run(before).changes, meals: db.prepare(archive.clearMeals).run(before).changes, pdfs: db.prepare(archive.clearPdfs).run(before).changes }));
    res.json({ deleted, done: deleted.scans < CLEAR_ROWS && deleted.meals < CLEAR_ROWS && deleted.pdfs < CLEAR_PDFS, cleanup: null });
  });
  app.post('/api/settings', auth, (req, res) => {
    const { printer: p, source: s } = req.body;
    if (p) {
      if (![p.widthMm,p.heightMm].every(n => typeof n === 'number' && Number.isFinite(n)) || p.widthMm < 40 || p.widthMm > 104 || p.heightMm < 50.8 || p.heightMm > 200 || (p.heightMm < 80 && p.widthMm < 70) || typeof p.name !== 'string' || p.name.length > 150) throw fail('Use a label width of 40–104 mm and height of 50.8–200 mm. Labels below 80 mm high need at least 70 mm width; enter the printer name.');
      setSetting('printer', { widthMm: p.widthMm, heightMm: p.heightMm, name: p.name, confirmed: true });
    }
    if (s) {
      if (!/^[\w-]{20,100}$/.test(s.spreadsheetId) || typeof s.tab !== 'string' || !s.tab.trim() || s.tab.length > 100) throw fail('Enter a valid Google spreadsheet URL and tab name.');
      const dailyTimes = s.dailyTimes || [];
      if (!Array.isArray(dailyTimes) || dailyTimes.length > 24 || dailyTimes.some(t=>typeof t!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) throw fail('Daily sync times must use HH:mm in Karbala time.');
      setSetting('source', { spreadsheetId: s.spreadsheetId, tab: s.tab.trim(), dailyTimes: [...new Set(dailyTimes)].sort() });
    }
    res.json({ ok: true });
  });
  app.get('/api/sync/config', (req, res) => {
    if (!equal(req.headers.authorization || '', `Bearer ${config.syncToken}`)) return res.status(401).json({ error: 'Invalid sync token.' });
    res.json({ ...source(), requestedAt: getSetting('syncRequestedAt',null), lastSuccess: getSetting('sync',null)?.lastSuccess || null });
  });
  app.post('/api/sync/request', auth, (req,res)=>{setSetting('syncRequestedAt',now().toISOString());res.json({ok:true});});
  app.post('/api/sync/tours', (req, res) => {
    if (!equal(req.headers.authorization || '', `Bearer ${config.syncToken}`)) return res.status(401).json({ error: 'Invalid sync token.' });
    const s = source(); if (req.body.spreadsheetId !== s.spreadsheetId || req.body.tab !== s.tab) throw fail('Source workbook or tab does not match Settings.',409);
    if (!Array.isArray(req.body.tours) || req.body.tours.length > 10000) throw fail('Invalid tours payload.');
    let tours; try { tours = req.body.tours.map(t => validateTour(t)); } catch (e) { throw fail(e.message); }
    const keys = tours.map(t => `${t.tour_id}|${t.arrival}`);
    if (new Set(keys).size !== keys.length) throw fail('Duplicate tour stays in source; sync refused.');
    transaction(db, () => {
      db.prepare("UPDATE tours SET active=0 WHERE source='sheets'").run();
      for (const t of tours.filter(t => t.departure >= START_DATE)) {
        const key = `${s.spreadsheetId}|${s.tab}|${t.tour_id}|${t.arrival}`;
        const old = db.prepare('SELECT id FROM tours WHERE source_key=? OR (tour_id=? AND arrival=?)').get(key,t.tour_id,t.arrival);
        const overlap = db.prepare('SELECT id FROM tours WHERE tour_id=? AND arrival<>? AND arrival<=? AND departure>=?').get(t.tour_id,t.arrival,t.departure,t.arrival);
        if (overlap) throw fail('Arrival-date correction overlaps an existing stay for '+t.tour_id+'. Sync refused to avoid duplicate meal entitlements.',409);
        if (old) db.prepare('UPDATE tours SET office=?,departure=?,pax=?,source=?,source_key=?,active=1 WHERE id=?').run(t.office,t.departure,t.pax,'sheets',key,old.id);
        else db.prepare('INSERT INTO tours(id,tour_id,office,arrival,departure,pax,source,source_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid(),t.tour_id,t.office,t.arrival,t.departure,t.pax,'sheets',key,now().toISOString());
      }
      setSetting('sync', { lastSuccess: now().toISOString(), imported: tours.length, tabs: Array.isArray(req.body.tabs) ? req.body.tabs.filter(t=>typeof t==='string').slice(0,100) : [], warnings: Array.isArray(req.body.warnings) ? req.body.warnings.map(String).slice(0,30) : [] });
    });
    res.json({ ok: true, count: tours.length });
  });
  app.use(express.static(resolve('public'), { index: false, maxAge: '1h' }));
  app.get(['/', '/scanner'], (req, res) => res.sendFile(resolve('public/index.html')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const conflict = /UNIQUE constraint/.test(err.message);
    if ((!err.status || err.status >= 500) && !conflict) console.error('Request failed:', err.message);
    res.status(conflict ? 409 : (err.status || 500)).json({ error: conflict ? 'This record changed during printing. Refresh and open the print log before trying again.' : err.status ? err.message : 'The request could not be completed. Please try again.' });
  });
  return app;
}
