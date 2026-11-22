-- A card with no number under its QR (printed before card numbers, or rubbed off) can be checked at the gate by typing
-- only its tour number: one guest of that tour who has not had this meal is admitted (see src/scan-query.js).
-- Such a meal is marked by_tour. If that guest's own card is scanned later, the meal moves to another guest of the tour
-- who has not eaten, so the card still goes green and the tour never gets more meals than its PAX. Purely additive.
ALTER TABLE admissions ADD COLUMN by_tour INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_logs ADD COLUMN by_tour INTEGER;
-- Gate phones download today's tour-number meals on every poll; this keeps that read to those meals.
CREATE INDEX admissions_by_tour ON admissions(date,meal) WHERE by_tour=1;
-- An admitted scan records its meal. First, a tour-number meal held by this guest moves to the guest of the same tour
-- number with the highest card number who is staying, within PAX, holds a current card and has not had this meal
-- (as freeGuestSql in src/scan-query.js; CROSS JOIN keeps the read to that tour number's people).
DROP TRIGGER IF EXISTS admit_logged_scan;
CREATE TRIGGER admit_logged_scan AFTER INSERT ON scan_logs WHEN NEW.reason='admitted' AND NEW.meal IS NOT NULL BEGIN
 UPDATE admissions SET (person_id,card_id)=(SELECT p2.id,c2.id FROM people p2 CROSS JOIN tours t2 ON t2.id=p2.tour_id
   CROSS JOIN cards c2 ON c2.person_id=p2.id AND c2.revoked_at IS NULL
   WHERE p2.sticker_tour=(SELECT sticker_tour FROM people WHERE id=NEW.person_id) AND t2.active=1 AND t2.arrival<=NEW.date AND t2.departure>=NEW.date
    AND p2.person_no<=t2.pax AND NOT EXISTS(SELECT 1 FROM admissions a2 WHERE a2.person_id=p2.id AND a2.date=NEW.date AND a2.meal=NEW.meal)
   ORDER BY p2.sticker_no DESC LIMIT 1)
  WHERE person_id=NEW.person_id AND date=NEW.date AND meal=NEW.meal AND by_tour=1;
 INSERT INTO admissions(person_id,date,meal,card_id,scanned_at,by_tour) VALUES(NEW.person_id,NEW.date,NEW.meal,NEW.card_id,NEW.scanned_at,COALESCE(NEW.by_tour,0));
END;
