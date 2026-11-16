-- Meal cards print a card number under the QR code (see src/sticker.js): the person's sticker number followed by the
-- tour number, such as 375253. Gate staff type it when a QR will not scan. Purely additive.
ALTER TABLE people ADD COLUMN sticker_no INTEGER;
ALTER TABLE people ADD COLUMN sticker_tour TEXT;
CREATE INDEX people_sticker ON people(sticker_tour,sticker_no);
-- A scan typed at the gate keeps the number that was typed; a QR scan leaves it NULL.
ALTER TABLE scan_logs ADD COLUMN typed_code TEXT;
-- People printed before this change keep their person number as their sticker number, so a stay printed in parts
-- continues after it. Their stickers show no number. Stays added under a tour ID already in the app are left
-- unnumbered, because their person numbers repeat the first stay's.
UPDATE people SET sticker_no=person_no,sticker_tour=(SELECT CASE
  WHEN t.tour_id GLOB '[0-9][0-9]/[0-9]*' AND length(t.tour_id) BETWEEN 4 AND 9 AND substr(t.tour_id,4) NOT GLOB '*[^0-9]*' THEN substr(t.tour_id,4)
  WHEN t.tour_id GLOB '[0-9]*' AND length(t.tour_id) BETWEEN 1 AND 6 AND t.tour_id NOT GLOB '*[^0-9]*' THEN t.tour_id END
  FROM tours t WHERE t.id=people.tour_id)
 WHERE EXISTS(SELECT 1 FROM tours t WHERE t.id=people.tour_id AND t.tour_id IS NOT NULL);
UPDATE people SET sticker_no=NULL WHERE sticker_tour IS NULL;
-- Two people whose stays share a tour number and overlap in dates never get the same sticker number,
-- even when two computers print for the same tour at the same moment.
CREATE TRIGGER validate_sticker_no BEFORE INSERT ON people WHEN NEW.sticker_no IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM tours n JOIN tours o ON o.arrival<=n.departure AND o.departure>=n.arrival
   JOIN people p ON p.tour_id=o.id AND p.sticker_tour=NEW.sticker_tour AND p.sticker_no=NEW.sticker_no WHERE n.id=NEW.tour_id)
 THEN RAISE(ABORT,'duplicate_sticker_no') END;
END;
