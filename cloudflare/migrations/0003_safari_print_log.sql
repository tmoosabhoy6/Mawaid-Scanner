-- Safari sticker jobs are saved in the print log like QR card jobs. A Safari job has no cards,
-- so this table records which Safari cards each saved PDF holds. Purely additive.
CREATE TABLE safari_prints(batch_id TEXT NOT NULL REFERENCES batches(id),safari_id TEXT NOT NULL REFERENCES safaris(id),PRIMARY KEY(batch_id,safari_id));
CREATE INDEX safari_prints_safari ON safari_prints(safari_id);
