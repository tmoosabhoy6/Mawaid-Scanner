import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY, tour_id TEXT NOT NULL, office TEXT NOT NULL,
      arrival TEXT NOT NULL, departure TEXT NOT NULL, pax INTEGER NOT NULL CHECK(pax>0),
      source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(tour_id,arrival),
      CHECK(arrival<=departure));
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
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
