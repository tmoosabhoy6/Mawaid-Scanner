-- Extended stays: extra meals after a tour's departure, on the same QR cards. Purely additive.
-- meals is 'day' (breakfast, lunch and dinner) or 'lunch'. A changed or removed extension keeps its row
-- with removed_at set, so the history stays available for reporting.
CREATE TABLE tour_extensions(id TEXT PRIMARY KEY,tour_id TEXT NOT NULL REFERENCES tours(id),date TEXT NOT NULL,
 meals TEXT NOT NULL CHECK(meals IN ('day','lunch')),created_at TEXT NOT NULL,removed_at TEXT);
CREATE UNIQUE INDEX tour_extension_active ON tour_extensions(tour_id,date) WHERE removed_at IS NULL;
CREATE INDEX tour_extensions_date ON tour_extensions(date);
-- Scans checked on a phone without a connection are sent later and marked offline.
ALTER TABLE scan_logs ADD COLUMN offline INTEGER NOT NULL DEFAULT 0;
-- Gate phones download the cards of current stays; this keeps that lookup to the stays themselves.
CREATE INDEX tours_departure ON tours(departure);
