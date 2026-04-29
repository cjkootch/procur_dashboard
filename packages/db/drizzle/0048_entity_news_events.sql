-- Layer 3 — entity_news_events.
--
-- Discrete public-source events relevant to a counterparty's
-- motivation to deal: bankruptcy filings (PACER), SEC/SEDAR offtake
-- changes, leadership turnover, refinery turnaround announcements,
-- sanctions actions, trade-press distress signals.
--
-- Distinct from supplier_signals (the existing tenant-private
-- behavioral table) — this one captures publicly-disclosed events
-- and is shared across all tenants. No companyId scope.
--
-- Linked to either a known_entity (preferred — analyst-curated) or
-- an external_supplier (when it's a public-procurement winner).
-- Both nullable: some events pertain to entities not in either
-- table; we still capture them via source_entity_name and
-- retroactively link when the entity gets added later.
--
-- relevance_score is set by an LLM extraction step (0.0-1.0). Below
-- 0.5 = noise; above 0.8 = high signal.

CREATE TABLE entity_news_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Either or both populated. NULL when extraction couldn't resolve.
  known_entity_id uuid REFERENCES known_entities(id) ON DELETE SET NULL,
  external_supplier_id uuid REFERENCES external_suppliers(id) ON DELETE SET NULL,

  -- Verbatim entity name from source — kept for retroactive linking
  -- when known_entities or external_suppliers gain a new row.
  source_entity_name text NOT NULL,
  source_entity_country text,

  -- Free-text vocabulary so we don't have to migrate the table every
  -- time a new source comes online. See schema doc-string for the
  -- canonical set we're seeding ingest workers around.
  event_type text NOT NULL,
  event_date date NOT NULL,

  summary text NOT NULL,
  raw_payload jsonb,

  -- Source identifiers.
  source text NOT NULL,
  source_url text,
  source_doc_id text,

  -- 0.00-1.00 LLM relevance score.
  relevance_score numeric(3, 2),

  ingested_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX entity_news_events_entity_idx
  ON entity_news_events (known_entity_id);
--> statement-breakpoint
CREATE INDEX entity_news_events_supplier_idx
  ON entity_news_events (external_supplier_id);
--> statement-breakpoint
CREATE INDEX entity_news_events_type_idx
  ON entity_news_events (event_type);
--> statement-breakpoint
CREATE INDEX entity_news_events_date_idx
  ON entity_news_events (event_date DESC);
--> statement-breakpoint

-- Trigram GIN for fuzzy entity-name matching when we get a hit on a
-- name that isn't yet linked to known_entities / external_suppliers.
-- pg_trgm is already enabled by 0032.
CREATE INDEX entity_news_events_name_trgm_idx
  ON entity_news_events USING gin (source_entity_name gin_trgm_ops);
--> statement-breakpoint

-- Idempotency for ingest workers — same source emits the same
-- (source, source_doc_id) at most once.
CREATE UNIQUE INDEX entity_news_events_source_doc_uniq
  ON entity_news_events (source, source_doc_id)
  WHERE source_doc_id IS NOT NULL;
