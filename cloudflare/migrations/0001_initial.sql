PRAGMA foreign_keys = ON;
CREATE TABLE tours (
 id TEXT PRIMARY KEY, tour_id TEXT NOT NULL, office TEXT NOT NULL,
 arrival TEXT NOT NULL, departure TEXT NOT NULL, pax INTEGER NOT NULL CHECK(pax>0),
 source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE, created_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, UNIQUE(tour_id,arrival), CHECK(arrival<=departure)
);
CREATE INDEX tours_dates ON tours(active,arrival,departure);
CREATE TABLE people(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),person_no INTEGER NOT NULL,UNIQUE(tour_id,person_no));
CREATE TABLE batches(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,pdf BLOB,envelope TEXT,remaining INTEGER NOT NULL DEFAULT 0,printer_status TEXT NOT NULL DEFAULT 'awaiting_pdf');
CREATE TABLE cards(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),batch_id TEXT NOT NULL REFERENCES batches(id),token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,revoked_at TEXT);
CREATE UNIQUE INDEX active_person_card ON cards(person_id) WHERE revoked_at IS NULL;
CREATE INDEX cards_batch ON cards(batch_id);
CREATE TABLE admissions(person_id TEXT NOT NULL REFERENCES people(id),date TEXT NOT NULL,meal TEXT NOT NULL,card_id TEXT NOT NULL REFERENCES cards(id),scanned_at TEXT NOT NULL,PRIMARY KEY(person_id,date,meal));
CREATE INDEX admissions_date ON admissions(date,person_id);
CREATE TABLE scan_logs(id INTEGER PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,card_id TEXT,person_id TEXT,tour_id TEXT,person_no INTEGER,date TEXT NOT NULL,meal TEXT,reason TEXT NOT NULL,scanned_at TEXT NOT NULL);
CREATE INDEX scan_log_date ON scan_logs(date,tour_id);
CREATE TABLE sessions(hash TEXT PRIMARY KEY,role TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE login_attempts(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX login_expiry ON login_attempts(expires);
-- The log insert and admission happen in the same SQLite statement/transaction.
-- All eligibility predicates are evaluated by that statement on the primary database.
CREATE TRIGGER admit_logged_scan AFTER INSERT ON scan_logs WHEN NEW.reason='admitted' BEGIN
 INSERT INTO admissions VALUES(NEW.person_id,NEW.date,NEW.meal,NEW.card_id,NEW.scanned_at);
END;
CREATE TRIGGER validate_person BEFORE INSERT ON people BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tours WHERE id=NEW.tour_id AND active=1 AND NEW.person_no BETWEEN 1 AND pax)
 THEN RAISE(ABORT,'invalid_person_capacity') END;
END;
CREATE TRIGGER validate_card BEFORE INSERT ON cards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM people p JOIN tours t ON t.id=p.tour_id WHERE p.id=NEW.person_id AND t.active=1 AND p.person_no<=t.pax)
 THEN RAISE(ABORT,'invalid_person_capacity') END;
END;
CREATE TRIGGER disallow_overlap_insert BEFORE INSERT ON tours BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tours WHERE tour_id=NEW.tour_id AND arrival<>NEW.arrival AND arrival<=NEW.departure AND departure>=NEW.arrival)
 THEN RAISE(ABORT,'overlapping_tour') END;
END;
CREATE TRIGGER disallow_overlap_update BEFORE UPDATE OF arrival,departure ON tours BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tours WHERE id<>NEW.id AND tour_id=NEW.tour_id AND arrival<>NEW.arrival AND arrival<=NEW.departure AND departure>=NEW.arrival)
 THEN RAISE(ABORT,'overlapping_tour') END;
END;
