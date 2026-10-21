-- Scanning no longer uses meal times: a recognised card is green on any day of its stay,
-- so scans are no longer recorded as per-meal admissions. Earlier admissions are kept.
DROP TRIGGER IF EXISTS admit_logged_scan;
-- Tour ID becomes optional for tours added by hand, and tours gain an optional ITS.
-- SQLite cannot relax NOT NULL in place, so tours is rebuilt. The tables that reference it
-- (people, then cards and admissions) are rebuilt alongside, because dropping a parent table
-- that still has child rows leaves a foreign-key violation that D1 refuses at commit.
-- Every row keeps its rowid, so archive cursors are unchanged.
PRAGMA defer_foreign_keys = true;
DROP TRIGGER IF EXISTS validate_person;
DROP TRIGGER IF EXISTS validate_card;
DROP TRIGGER IF EXISTS disallow_overlap_insert;
DROP TRIGGER IF EXISTS disallow_overlap_update;
CREATE TABLE tours_new (
 id TEXT PRIMARY KEY, tour_id TEXT, its TEXT, office TEXT NOT NULL,
 arrival TEXT NOT NULL, departure TEXT NOT NULL, pax INTEGER NOT NULL CHECK(pax>0),
 source TEXT NOT NULL DEFAULT 'manual', source_key TEXT UNIQUE, created_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, UNIQUE(tour_id,arrival), CHECK(arrival<=departure)
);
CREATE TABLE people_new(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours_new(id),person_no INTEGER NOT NULL,UNIQUE(tour_id,person_no));
CREATE TABLE cards_new(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people_new(id),batch_id TEXT NOT NULL REFERENCES batches(id),token_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE admissions_new(person_id TEXT NOT NULL REFERENCES people_new(id),date TEXT NOT NULL,meal TEXT NOT NULL,card_id TEXT NOT NULL REFERENCES cards_new(id),scanned_at TEXT NOT NULL,PRIMARY KEY(person_id,date,meal));
INSERT INTO tours_new(rowid,id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active)
 SELECT rowid,id,tour_id,office,arrival,departure,pax,source,source_key,created_at,active FROM tours;
INSERT INTO people_new(rowid,id,tour_id,person_no) SELECT rowid,id,tour_id,person_no FROM people;
INSERT INTO cards_new(rowid,id,person_id,batch_id,token_hash,created_at,revoked_at)
 SELECT rowid,id,person_id,batch_id,token_hash,created_at,revoked_at FROM cards;
INSERT INTO admissions_new(rowid,person_id,date,meal,card_id,scanned_at)
 SELECT rowid,person_id,date,meal,card_id,scanned_at FROM admissions;
DROP TABLE admissions;
DROP TABLE cards;
DROP TABLE people;
DROP TABLE tours;
-- Renaming also rewrites the REFERENCES clauses of the new tables.
ALTER TABLE tours_new RENAME TO tours;
ALTER TABLE people_new RENAME TO people;
ALTER TABLE cards_new RENAME TO cards;
ALTER TABLE admissions_new RENAME TO admissions;
CREATE INDEX tours_dates ON tours(active,arrival,departure);
CREATE UNIQUE INDEX active_person_card ON cards(person_id) WHERE revoked_at IS NULL;
CREATE INDEX cards_batch ON cards(batch_id);
CREATE INDEX admissions_date ON admissions(date,person_id);
CREATE TRIGGER validate_person BEFORE INSERT ON people BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tours WHERE id=NEW.tour_id AND active=1 AND NEW.person_no BETWEEN 1 AND pax)
 THEN RAISE(ABORT,'invalid_person_capacity') END;
END;
CREATE TRIGGER validate_card BEFORE INSERT ON cards BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM people p JOIN tours t ON t.id=p.tour_id WHERE p.id=NEW.person_id AND t.active=1 AND p.person_no<=t.pax)
 THEN RAISE(ABORT,'invalid_person_capacity') END;
END;
-- A tour without an ID never overlaps another: NULL tour IDs never compare equal.
CREATE TRIGGER disallow_overlap_insert BEFORE INSERT ON tours BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tours WHERE tour_id=NEW.tour_id AND arrival<>NEW.arrival AND arrival<=NEW.departure AND departure>=NEW.arrival)
 THEN RAISE(ABORT,'overlapping_tour') END;
END;
CREATE TRIGGER disallow_overlap_update BEFORE UPDATE OF arrival,departure ON tours BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tours WHERE id<>NEW.id AND tour_id=NEW.tour_id AND arrival<>NEW.arrival AND arrival<=NEW.departure AND departure>=NEW.arrival)
 THEN RAISE(ABORT,'overlapping_tour') END;
END;
-- Safari (takeaway) cards: one sticker without a QR code for a whole stay. Every field is optional.
CREATE TABLE safaris(id TEXT PRIMARY KEY,office TEXT,tour_id TEXT,its TEXT,arrival TEXT,departure TEXT,
 pax INTEGER CHECK(pax IS NULL OR pax>0),created_at TEXT NOT NULL,
 CHECK(arrival IS NULL OR departure IS NULL OR arrival<=departure));
CREATE INDEX safaris_arrival ON safaris(arrival);
