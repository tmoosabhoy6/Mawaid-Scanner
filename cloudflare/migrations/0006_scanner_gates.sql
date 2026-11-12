-- The scanner is split into a Men's and a Women's tab; each scan records which one checked it.
-- Purely additive: earlier scans keep gate NULL and show as having no scanner recorded.
ALTER TABLE scan_logs ADD COLUMN gate TEXT CHECK(gate IS NULL OR gate IN ('men','women'));
