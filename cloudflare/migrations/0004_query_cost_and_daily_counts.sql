CREATE INDEX cards_person_batch ON cards(person_id,batch_id);
CREATE INDEX IF NOT EXISTS cards_batch ON cards(batch_id);
DROP INDEX IF EXISTS scan_log_date;
CREATE INDEX scan_log_date ON scan_logs(date,id DESC);
CREATE INDEX IF NOT EXISTS tours_dates ON tours(active,arrival,departure);
CREATE INDEX IF NOT EXISTS admissions_date ON admissions(date,person_id);
CREATE INDEX batches_created ON batches(created_at DESC);
CREATE TABLE daily_scan_counts (
 date TEXT PRIMARY KEY, breakfast INTEGER NOT NULL DEFAULT 0, lunch INTEGER NOT NULL DEFAULT 0,
 dinner INTEGER NOT NULL DEFAULT 0, other INTEGER NOT NULL DEFAULT 0
);
INSERT INTO daily_scan_counts(date,breakfast,lunch,dinner,other)
 SELECT date,SUM(COALESCE(meal='breakfast',0)),SUM(COALESCE(meal='lunch',0)),SUM(COALESCE(meal='dinner',0)),SUM(meal IS NULL OR meal NOT IN ('breakfast','lunch','dinner'))
 FROM scan_logs WHERE reason='admitted' GROUP BY date;
CREATE TRIGGER count_admitted_scan AFTER INSERT ON scan_logs WHEN NEW.reason='admitted' BEGIN
 INSERT INTO daily_scan_counts(date,breakfast,lunch,dinner,other)
 VALUES(NEW.date,COALESCE(NEW.meal='breakfast',0),COALESCE(NEW.meal='lunch',0),COALESCE(NEW.meal='dinner',0),NEW.meal IS NULL OR NEW.meal NOT IN ('breakfast','lunch','dinner'))
 ON CONFLICT(date) DO UPDATE SET breakfast=breakfast+excluded.breakfast,lunch=lunch+excluded.lunch,dinner=dinner+excluded.dinner,other=other+excluded.other;
END;
CREATE TRIGGER uncount_admitted_scan AFTER DELETE ON scan_logs WHEN OLD.reason='admitted' BEGIN
 UPDATE daily_scan_counts SET breakfast=breakfast-COALESCE(OLD.meal='breakfast',0),lunch=lunch-COALESCE(OLD.meal='lunch',0),dinner=dinner-COALESCE(OLD.meal='dinner',0),other=other-(OLD.meal IS NULL OR OLD.meal NOT IN ('breakfast','lunch','dinner')) WHERE date=OLD.date;
END;
DROP TRIGGER IF EXISTS admit_logged_scan;
CREATE TRIGGER admit_logged_scan AFTER INSERT ON scan_logs WHEN NEW.reason='admitted' AND NEW.meal IS NOT NULL BEGIN
 INSERT INTO admissions(person_id,date,meal,card_id,scanned_at) VALUES(NEW.person_id,NEW.date,NEW.meal,NEW.card_id,NEW.scanned_at);
END;
