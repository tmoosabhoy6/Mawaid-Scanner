import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID, createHash, timingSafeEqual, scryptSync } from 'node:crypto';
import { join, resolve } from 'node:path';
import { openDatabase, transaction } from './db.js';
import { eligibility, serviceAt, validateTour, validateSafari, TIME_ZONE, START_DATE } from './rules.js';
import { makeLabels } from './labels.js';
import { listOrder, tourStatus, safariStatus } from './tour-list.js';
import { SUMMARY_SQL } from './summary.js';
import { ARCHIVE_DATASETS, archiveSql, archiveCutoff, archivePage, CLEAR_ROWS, CLEAR_PDFS } from './archive.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const x = hash(a), y = hash(b); return timingSafeEqual(Buffer.from(x), Buffer.from(y)); };
const uid = () => randomUUID();
const token = () => randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const reasons = { admitted: 'Welcome — meal allowed', before_arrival: 'Arrival date has not started', after_departure: 'Departure date has passed', replaced_card: 'This card was replaced', unknown_card: 'Card not recognised', over_capacity: 'Person exceeds the current tour PAX', inactive_tour: 'Tour is no longer active in the source sheet' };
export function createApp(options = {}) {
  const config = { origin: process.env.APP_ORIGIN || 'http://localhost:3000',
    adminPassword: process.env.ADMIN_PASSWORD || '', scannerPassword: process.env.SCANNER_PASSWORD || '',
    syncToken: process.env.SYNC_TOKEN || '', dataDir: resolve(process.env.DATA_DIR || '.data'), ...options };
  if (!config.adminPassword || !config.scannerPassword || config.syncToken.length < 32) throw new Error('Set ADMIN_PASSWORD and SCANNER_PASSWORD and SYNC_TOKEN (32+ characters).');
  if (equal(config.adminPassword, config.scannerPassword)) throw new Error('Use different admin and scanner passwords.');
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
  const auth = (role) => (req, res, next) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('mawayid_session='))?.slice(16);
    const session = raw && db.prepare('SELECT role FROM sessions WHERE hash=? AND expires>?').get(hash(raw), Date.now());
    if (!session) return res.status(401).json({ error: 'Please sign in.' });
    if (role === 'admin' && session.role !== 'admin') return res.status(403).json({ error: 'Admin access is required.' });
    req.role = session.role; next();
  };
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const salt = randomBytes(16);
  const passwordHashes = { admin: scryptSync(config.adminPassword, salt, 32), scanner: scryptSync(config.scannerPassword, salt, 32) };
  app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  app.post('/api/login', loginLimit, (req, res) => {
    const role = req.body.role === 'scanner' ? 'scanner' : 'admin';
    if (typeof req.body.password !== 'string' || req.body.password.length > 256 || !timingSafeEqual(scryptSync(req.body.password, salt, 32), passwordHashes[role])) return res.status(401).json({ error: 'Incorrect password.' });
    const session = token(); db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), role, Date.now() + 12 * 60 * 60 * 1000);
    res.cookie('mawayid_session', session, { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000, path: '/' });
    res.json({ role });
  });
  app.post('/api/logout', auth(), (req, res) => {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('mawayid_session='))?.slice(16);
    if (raw) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(raw));
    res.clearCookie('mawayid_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/session', auth(), (req, res) => res.json({ role: req.role }));
  app.get('/api/service', auth(), (req, res) => res.json({ ...serviceAt(now()), serverTime: now().toISOString(), timezone: TIME_ZONE, startDate: START_DATE }));
  app.get('/api/tours', auth('admin'), (req, res) => {
    const sort = String(req.query.sort || ''), status = String(req.query.status || '');
    const rows = db.prepare(`SELECT x.*, (SELECT printer_status FROM batches WHERE id=x.batch_id) AS batch_status FROM (SELECT t.*, (SELECT COUNT(*) FROM people p WHERE p.tour_id=t.id) AS issued,
      (SELECT b.id FROM batches b JOIN cards c ON c.batch_id=b.id JOIN people p ON p.id=c.person_id WHERE p.tour_id=t.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1) AS batch_id
      FROM tours t WHERE t.active=1 AND ${tourStatus(status)} AND (?='' OR t.arrival=?) AND (?='' OR t.tour_id LIKE ? OR t.office LIKE ? OR t.its LIKE ?)) x ORDER BY ${listOrder(sort, 'x.')}`).all(
      req.query.arrival || '', req.query.arrival || '', req.query.q || '', `%${req.query.q || ''}%`, `%${req.query.q || ''}%`, `%${req.query.q || ''}%`);
    res.json(rows);
  });
  app.post('/api/tours', auth('admin'), (req, res) => {
    let t; try { t = validateTour(req.body, { requireId: false }); } catch (e) { throw fail(e.message); }
    // Reusing a tour ID for the same stay returns the existing entitlement instead of adding seats.
    const existing = t.tour_id && db.prepare('SELECT * FROM tours WHERE tour_id=? AND arrival=?').get(t.tour_id, t.arrival);
    if (existing) return res.json({ ...existing, existing: true });
    const id = uid(); db.prepare('INSERT INTO tours(id,tour_id,its,office,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, t.tour_id, t.its, t.office, t.arrival, t.departure, t.pax, now().toISOString());
    res.status(201).json({ id, ...t });
  });
  // Safari cards print without a QR code, so they have no people, cards or scans.
  app.get('/api/safaris', auth('admin'), (req, res) => {
    const arrival = req.query.arrival || '', q = req.query.q || '', sort = String(req.query.sort || ''), status = String(req.query.status || '');
    res.json(db.prepare(`SELECT x.*,(SELECT printer_status FROM batches WHERE id=x.batch_id) AS batch_status FROM (SELECT s.*,
      (SELECT b.id FROM batches b JOIN safari_prints sp ON sp.batch_id=b.id WHERE sp.safari_id=s.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 1) AS batch_id
      FROM safaris s WHERE ${safariStatus(status)} AND (?='' OR arrival=?) AND (?='' OR tour_id LIKE ? OR office LIKE ? OR its LIKE ?) ORDER BY ${listOrder(sort, 's.')},s.created_at LIMIT 1000) x ORDER BY ${listOrder(sort, 'x.')},x.created_at`).all(arrival, arrival, q, `%${q}%`, `%${q}%`, `%${q}%`));
  });
  app.post('/api/safaris', auth('admin'), (req, res) => {
    let s; try { s = validateSafari(req.body); } catch (e) { throw fail(e.message); }
    const row = { id: uid(), ...s, created_at: now().toISOString() };
    db.prepare('INSERT INTO safaris(id,office,tour_id,its,arrival,departure,pax,created_at) VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));
    res.status(201).json(row);
  });
  // The printing computer draws Safari stickers and saves the PDF here before printing, so the job appears in Print log.
  app.post('/api/safaris/print', auth('admin'), express.raw({ type: 'application/pdf', limit: '3mb' }), (req, res) => {
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
  app.get('/api/tours/:id/people', auth('admin'), (req, res) => res.json(db.prepare(`SELECT p.id,p.person_no,c.id AS card_id,c.created_at FROM people p LEFT JOIN cards c ON c.person_id=p.id AND c.revoked_at IS NULL WHERE p.tour_id=? ORDER BY p.person_no`).all(req.params.id)));
  app.post('/api/labels', auth('admin'), async (req, res) => {
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
  app.get('/api/batches', auth('admin'), (req, res) => res.json(db.prepare(`SELECT b.id,b.created_at,b.kind,b.printer_status,b.pdf IS NOT NULL AS pdf_ready,COUNT(c.id)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS count,SUM(CASE WHEN c.id IS NOT NULL AND c.revoked_at IS NULL THEN 1 ELSE 0 END)+(SELECT COUNT(*) FROM safari_prints s WHERE s.batch_id=b.id) AS active_count FROM batches b LEFT JOIN cards c ON c.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 200`).all()));
  app.get('/api/batches/:id/pdf', auth('admin'), (req, res) => {
    const batch = db.prepare('SELECT pdf,printer_status FROM batches WHERE id=?').get(req.params.id);
    if (batch?.printer_status === 'pdf_cleared') throw fail('This label PDF was cleared after the stay ended. Use Replace cards if a guest still needs a card.', 410);
    if (!batch?.pdf) throw fail('PDF not found.', 404);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="mawaid-${req.params.id}.pdf"` }).send(Buffer.from(batch.pdf));
  });
  app.post('/api/batches/:id/status', auth('admin'), (req, res) => {
    if (!['sent_to_printer','printer_error'].includes(req.body.status)) throw fail('Invalid printer status.');
    db.prepare('UPDATE batches SET printer_status=? WHERE id=? AND pdf IS NOT NULL').run(req.body.status, req.params.id); res.json({ ok: true });
  });
  app.post('/api/scan', auth(), (req, res) => {
    const { requestKey, code } = req.body;
    if (typeof requestKey !== 'string' || !/^[\w-]{16,100}$/.test(requestKey)) throw fail('A scan request key is required.');
    if (typeof code !== 'string' || code.length > 300) throw fail('Invalid QR code.');
    const result = transaction(db, () => {
      const previous = db.prepare('SELECT * FROM scan_logs WHERE request_key=?').get(requestKey);
      if (previous) return { ...previous, replayed: true };
      const c = code.startsWith('MW1:') ? db.prepare(`SELECT c.*,p.person_no,p.tour_id,t.arrival,t.departure,t.pax,t.active,t.office,t.tour_id AS display_tour FROM cards c JOIN people p ON p.id=c.person_id JOIN tours t ON t.id=p.tour_id WHERE c.token_hash=?`).get(hash(code.slice(4))) : null;
      // Green means a recognised card inside its stay dates; repeat scans are not limited by meal.
      const check = eligibility(c, now()); let reason = check.reason;
      if (c && !c.active) reason = 'inactive_tour';
      if (check.allowed && c.person_no > c.pax) reason = 'over_capacity';
      const row = { request_key: requestKey, card_id: c?.id || null, tour_id: c?.tour_id || null, person_no: c?.person_no || null, date: check.date, meal: null, reason, scanned_at: now().toISOString() };
      db.prepare('INSERT INTO scan_logs(request_key,card_id,tour_id,person_no,date,meal,reason,scanned_at) VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));
      return row;
    });
    // A network replay can acknowledge a prior admission but must not show a fresh green gate.
    res.json({ ...result, status: result.reason === 'admitted' && !result.replayed ? 'green' : 'red', message: result.replayed ? 'Request already processed — check the scan log before admitting' : reasons[result.reason], serverTime: now().toISOString() });
  });
  app.get('/api/logs', auth('admin'), (req, res) => {
    const { date = '', tour = '', status = '', office = '' } = req.query;
    res.json(db.prepare(`SELECT s.*,t.tour_id AS display_tour,t.office FROM scan_logs s LEFT JOIN tours t ON t.id=s.tour_id
      WHERE (?='' OR s.date=?) AND (?='' OR t.tour_id LIKE ?) AND (?='' OR t.office LIKE ?)
      AND (?='' OR (?='green' AND s.reason='admitted') OR (?='red' AND s.reason!='admitted')) ORDER BY s.id DESC LIMIT 1000`).all(date,date,tour,`%${tour}%`,office,`%${office}%`,status,status,status));
  });
  app.get('/api/summary', auth('admin'), (req, res) => {
    const date = req.query.date || serviceAt(now()).date;
    res.json(db.prepare(SUMMARY_SQL).all(date));
  });
  const databaseBytes = () => db.prepare('SELECT page_count*page_size AS n FROM pragma_page_count(),pragma_page_size()').get().n;
  app.get('/api/settings', auth('admin'), (req, res) => res.json({ printer: printer(), source: source(), sync: getSetting('sync', null), timeZone: TIME_ZONE, hosting: 'server', databaseBytes: databaseBytes() }));
  const archive = archiveSql(false), cutoff = value => { const today = serviceAt(now()).date; return archiveCutoff(value || today, today); };
  app.get('/api/archive', auth('admin'), (req, res) => {
    const before = cutoff(req.query.before);
    res.json({ before, today: serviceAt(now()).date, counts: db.prepare(archive.counts).get(before), databaseBytes: databaseBytes(), cleanup: null });
  });
  app.get('/api/archive/:dataset', auth('admin'), (req, res) => {
    const sql = Object.hasOwn(ARCHIVE_DATASETS, req.params.dataset) && ARCHIVE_DATASETS[req.params.dataset]; if (!sql) throw fail('Not found.', 404);
    const before = cutoff(req.query.before), { after, limit } = archivePage(new URL(req.url, 'http://local'));
    const rows = db.prepare(sql).all(before, after, limit);
    res.json({ rows, next: rows.length === limit ? rows.at(-1).cursor : null });
  });
  app.post('/api/archive/clear', auth('admin'), (req, res) => {
    const before = archiveCutoff(req.body.before, serviceAt(now()).date);
    const deleted = transaction(db, () => ({ scans: db.prepare(archive.clearScans).run(before).changes, meals: db.prepare(archive.clearMeals).run(before).changes, pdfs: db.prepare(archive.clearPdfs).run(before).changes }));
    res.json({ deleted, done: deleted.scans < CLEAR_ROWS && deleted.meals < CLEAR_ROWS && deleted.pdfs < CLEAR_PDFS, cleanup: null });
  });
  app.post('/api/settings', auth('admin'), (req, res) => {
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
  app.post('/api/sync/request', auth('admin'), (req,res)=>{setSetting('syncRequestedAt',now().toISOString());res.json({ok:true});});
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
