import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
const TOURS = `CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY, tour_id TEXT, its TEXT, office TEXT NOT NULL,
      arrival TEXT NOT NULL, departure TEXT NOT NULL, pax INTEGER NOT NULL CHECK(pax>0),
      source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(tour_id,arrival),
      CHECK(arrival<=departure))`;
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    ${TOURS};
    CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, tour_id TEXT NOT NULL REFERENCES tours(id), person_no INTEGER NOT NULL,
      UNIQUE(tour_id,person_no));
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL,
      request_key TEXT NOT NULL UNIQUE, pdf BLOB, printer_status TEXT NOT NULL DEFAULT 'generated');
    CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id),
      batch_id TEXT NOT NULL REFERENCES batches(id), token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_person_card ON cards(person_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS admissions (person_id TEXT NOT NULL REFERENCES people(id), date TEXT NOT NULL,
      meal TEXT NOT NULL, card_id TEXT NOT NULL REFERENCES cards(id), scanned_at TEXT NOT NULL,
      PRIMARY KEY(person_id,date,meal));
    CREATE TABLE IF NOT EXISTS scan_logs (id INTEGER PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
      card_id TEXT, tour_id TEXT, person_no INTEGER, date TEXT NOT NULL, meal TEXT,
      reason TEXT NOT NULL, scanned_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS scan_log_date ON scan_logs(date,tour_id);
    CREATE TABLE IF NOT EXISTS safaris (id TEXT PRIMARY KEY, office TEXT, tour_id TEXT, its TEXT, arrival TEXT, departure TEXT,
      pax INTEGER CHECK(pax IS NULL OR pax>0), created_at TEXT NOT NULL,
      CHECK(arrival IS NULL OR departure IS NULL OR arrival<=departure));
    CREATE TABLE IF NOT EXISTS safari_prints (batch_id TEXT NOT NULL REFERENCES batches(id), safari_id TEXT NOT NULL REFERENCES safaris(id),
      PRIMARY KEY(batch_id,safari_id));
    CREATE INDEX IF NOT EXISTS safari_prints_safari ON safari_prints(safari_id);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  upgradeTours(db);
  if (!db.prepare('PRAGMA table_info(scan_logs)').all().some(c => c.name === 'person_id')) db.exec('ALTER TABLE scan_logs ADD COLUMN person_id TEXT');
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='daily_scan_counts'").get()) {
    transaction(db, () => db.exec(readFileSync(new URL('../cloudflare/migrations/0004_query_cost_and_daily_counts.sql', import.meta.url), 'utf8')));
  }
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='tour_extensions'").get()) {
    transaction(db, () => db.exec(readFileSync(new URL('../cloudflare/migrations/0005_extensions_offline_scans.sql', import.meta.url), 'utf8')));
  }
  return db;
}
// Databases created before tour IDs became optional are rebuilt once, keeping every row and rowid.
function upgradeTours(db) {
  if (db.prepare('PRAGMA table_info(tours)').all().some(c => c.name === 'its')) return;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    transaction(db, () => db.exec(`${TOURS.replace('IF NOT EXISTS tours', 'tours_upgrade')};
      INSERT INTO tours_upgrade(rowid,id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active)
        SELECT rowid,id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active FROM tours;
      DROP TABLE tours; ALTER TABLE tours_upgrade RENAME TO tours;`));
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
