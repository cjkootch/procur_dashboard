-- Back-pointer from USDA FSIS establishment row to the known_entities
-- slug created via the website-intelligence pipeline. NULL until
-- promoted; non-NULL means the establishment has a corresponding
-- rolodex row that the existing crawl-entity-website infrastructure
-- can target for product / capacity / cut detail.
--
-- The known_entities row is the shadow record that downstream surfaces
-- (chat lookup_known_entities, map view, analyze_supplier) consume.
-- The USDA FSIS row stays canonical for regulatory data (establishment
-- number, species, activities, grants).

ALTER TABLE usda_fsis_establishments
  ADD COLUMN IF NOT EXISTS linked_known_entity_slug TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usda_fsis_establishments_linked_slug_idx
  ON usda_fsis_establishments (linked_known_entity_slug)
  WHERE linked_known_entity_slug IS NOT NULL;
