-- Apollo people-side schema additions (Day 1.5 of build per
-- docs/apollo-integration-brief.md §4.4).
--
-- Apollo plugs into the existing source-discriminated
-- entity_contact_enrichments table as `source = 'apollo'`. The
-- existing dedup key (entity_slug, source, contact_name_normalized)
-- already prevents duplicate Apollo entries, and the suggestion-
-- not-overwrite rule already protects the primary contact-of-record.
--
-- What's added:
--   - apollo_person_id: Apollo's stable person ID, needed for
--     re-enrichment over time. Required when source = 'apollo';
--     nullable for legacy source = 'vex' rows.
--   - seniority: Apollo's structured field (owner / founder /
--     c_suite / partner / vp / head / director / manager / senior
--     / entry / intern). Filterable in the Decision-makers panel
--     to surface decision-makers.
--   - apollo_last_refreshed_at: Apollo's data freshness timestamp,
--     distinct from enriched_at (procur's last write).

ALTER TABLE entity_contact_enrichments
  ADD COLUMN IF NOT EXISTS apollo_person_id text;
--> statement-breakpoint

ALTER TABLE entity_contact_enrichments
  ADD COLUMN IF NOT EXISTS seniority text;
--> statement-breakpoint

ALTER TABLE entity_contact_enrichments
  ADD COLUMN IF NOT EXISTS apollo_last_refreshed_at timestamp;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_contact_enrichments_apollo_person_id_idx
  ON entity_contact_enrichments (apollo_person_id)
  WHERE apollo_person_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_contact_enrichments_seniority_idx
  ON entity_contact_enrichments (seniority)
  WHERE seniority IS NOT NULL;
