-- ML Layer Phase 4 (Component D) — text embeddings for entity-mention
-- resolution. Per docs/procur-ml-layer-brief.md §7.1.
--
-- Distinct from entity_embeddings (Component A, vector(128) graph
-- embeddings from GraphSAGE). Different space, different purpose:
--   - graph embeddings  — structural similarity ("entities that share
--                         counterparties / co-occur in cargo trips /
--                         share ownership")
--   - text embeddings   — name + descriptive similarity ("entities
--                         whose name + description matches a free-text
--                         mention from news / customs / docs")
--
-- 1536 dims matches text-embedding-3-small (procur's standard, also
-- used by past_performance + content_library). pgvector + HNSW already
-- enabled procur-wide.

CREATE TABLE IF NOT EXISTS entity_text_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** Same canonical-key shape getEntityProfile + entity_embeddings
      use — accepts known_entities.slug or external_suppliers.id (UUID). */
  entity_slug text NOT NULL,

  /** Which composition of the entity's text was embedded:
        'name'                     — just the legal/canonical name
        'name_plus_aliases'        — name + every alias
        'name_plus_categories'     — name + categories array
        'combined_v1'              — name + aliases + categories + first 500 chars of notes
      Free text. Different kinds enable different similarity-search
      profiles (strict name match vs. contextual match). */
  embedding_kind text NOT NULL,

  /** The actual embedding. vector(1536) matches text-embedding-3-small. */
  embedding vector(1536) NOT NULL,

  /** The text that was embedded — kept for audit / debugging
      ("why does this entity match this query?"). Truncated to ~2KB
      since the model itself caps at 8K tokens. */
  source_text text NOT NULL,

  /** Embedding model identifier. e.g. 'text-embedding-3-small'.
      Bumping the model creates new rows; old versions persist
      briefly during deployment for rollback. */
  model_version text NOT NULL,

  created_at timestamp NOT NULL DEFAULT now(),

  /** One row per (entity, kind, model_version). Re-running seed with
      the same model overwrites in place. */
  UNIQUE (entity_slug, embedding_kind, model_version)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_text_embeddings_slug_idx
  ON entity_text_embeddings (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_text_embeddings_kind_idx
  ON entity_text_embeddings (embedding_kind);
--> statement-breakpoint

-- HNSW with cosine distance — production-standard ANN index.
CREATE INDEX IF NOT EXISTS entity_text_embeddings_hnsw_idx
  ON entity_text_embeddings USING hnsw (embedding vector_cosine_ops);
