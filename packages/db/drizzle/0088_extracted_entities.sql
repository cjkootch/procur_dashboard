-- GLiNER-extracted entities — polymorphic NER results from emails,
-- documents, web pages, web summaries, LOIs, ICPOs, etc.
--
-- Why a new table vs reusing entity_web_facts:
--   * entity_web_facts is entity-scoped (anchored to a known_entities
--     row via entity_slug + linked to entity_web_pages). GLiNER runs
--     against arbitrary text — inbound emails, deal notes, scraped
--     docs — that doesn't always tie back to a known entity.
--   * GLiNER produces NER spans (label + start/end offsets); facts
--     are higher-level claims. Different shape, different lifecycle.
--
-- Catalog code can join both tables when assembling an entity
-- profile; this PR just lays the foundation.

CREATE TABLE IF NOT EXISTS extracted_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* What text was scanned. Free text — producers choose the
     namespace. Examples: 'message' | 'document' | 'web_page' |
     'web_summary' | 'inbound_email' | 'deal_note' | 'loi' | 'icpo'
     | 'assay'. */
  source_type text NOT NULL,
  source_id text NOT NULL,

  /* GLiNER label — one of the v1 inventory: company | person |
     title | product | fuel_grade | crude_grade | port | terminal |
     vessel | bank | payment_instrument | incoterm | country |
     document_type. Free text so new labels slot in additively. */
  label text NOT NULL,

  /* Surface form as it appeared in the source. */
  value text NOT NULL,

  /* Char offsets in the source text — useful for highlighting and
     for offset-based dedupe. NULL when the producer can't supply
     them (e.g. when source text was already chunked). */
  start_offset integer,
  end_offset integer,

  /* GLiNER's softmax score for this span. */
  confidence numeric(3, 2),

  /* Optional resolved entity slug — when a downstream resolver maps
     `value` to an entity in known_entities, write it here. NULL
     until resolution runs (separate job). */
  resolved_entity_slug text,

  /* Model identifier; pinned per row so a future swap doesn't
     silently mix detection vocabularies. */
  model_version text NOT NULL DEFAULT 'gliner-multitask-v1',

  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS extracted_entities_source_idx
  ON extracted_entities (source_type, source_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS extracted_entities_label_idx
  ON extracted_entities (label);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS extracted_entities_resolved_idx
  ON extracted_entities (resolved_entity_slug)
  WHERE resolved_entity_slug IS NOT NULL;
--> statement-breakpoint

-- Dedupe: re-running GLiNER on the same source shouldn't pile up
-- duplicate spans. Unique on (source_type, source_id, label, value,
-- start_offset, model_version).
CREATE UNIQUE INDEX IF NOT EXISTS extracted_entities_uniq_idx
  ON extracted_entities (
    source_type,
    source_id,
    label,
    value,
    COALESCE(start_offset, -1),
    model_version
  );
