-- USDA FSIS MPI Directory CSV carries more columns than the initial
-- schema captured. Adding size_class (the operator's primary scale
-- signal), duns_number (stable corporate identifier — pairs with
-- Apollo enrichment), grant_date (when FSIS inspection began —
-- proxy for facility tenure), and the FSIS regulatory subdivisions
-- (district, circuit) for downstream filtering.
--
-- All nullable + additive — re-running the MPI ingest fills them
-- on existing rows via the upsert path.

ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS size_class TEXT;
--> statement-breakpoint
ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS duns_number TEXT;
--> statement-breakpoint
ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS grant_date DATE;
--> statement-breakpoint
ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS fsis_district TEXT;
--> statement-breakpoint
ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS fsis_circuit TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_size_class_idx
  ON usda_fsis_establishments (size_class);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_duns_idx
  ON usda_fsis_establishments (duns_number)
  WHERE duns_number IS NOT NULL;
