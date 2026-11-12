-- Add tour requires a tour ID. When that ID is already in the app, the new cards are a separate stay listed and
-- printed under the same ID. Its ID is kept here, with tour_id left NULL, so the one-stay-per-ID rule, the Google
-- Sheet sync and its overlap checks never see it. Display, search and stickers read COALESCE(tour_id,shared_tour_id).
ALTER TABLE tours ADD COLUMN shared_tour_id TEXT;
