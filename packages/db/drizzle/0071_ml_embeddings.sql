-- ML Layer Phase 1, Component A — vector store + ANN search
-- Per docs/procur-ml-layer-brief.md §4. Foundation infrastructure for
-- the GraphSAGE training pipeline (Component B), two-tower retrieval
-- (Component C), and entity resolution (Component D).
--
-- pgvector extension is already enabled procur-wide (bootstrap.ts +
-- migrate.ts run CREATE EXTENSION IF NOT EXISTS vector on every run);
-- past_performance + content_library tables already use vector(1536)
-- for text embeddings. This migration adds graph-derived 128-dim
-- embeddings on a per-entity and per-signal basis.
--
-- Why 128-dim and not 1536: graph embeddings live in a denser
-- structural space — PinSage uses 128, GraphSAGE is flexible, brief
-- recommends 128 as starting point. Text-embedding-3-large at 1536
-- (existing pp/cl tables) and graph embeddings at 128 are different
-- regimes — keep separate to avoid mixing similarity computations
-- across spaces.
--
-- Multiple embedding_kind per entity is intentional: 'graph_v1' from
-- Component B, 'attribute_v1' from text/structured features, and a
-- 'combined_v1' production-retrieval embedding stay queryable side-
-- by-side for debugging and A/B testing.

CREATE TABLE IF NOT EXISTS entity_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** Entity this embedding represents. Text (not FK) so it accepts
      both known_entities.slug and external_suppliers.id (UUID),
      same canonical-key shape getEntityProfile + fuel_consumption_signals
      use. Joins onto known_entities OR external_suppliers at query
      time. */
  entity_slug text NOT NULL,

  /** What kind of embedding this row stores:
        'graph_v1'      — GraphSAGE-derived from heterogeneous graph
        'attribute_v1'  — from name + categories + tags + notes
        'combined_v1'   — concat / weighted combination, production retrieval
      Free text — new kinds slot in without migration. */
  embedding_kind text NOT NULL,

  /** The vector itself. 128 dims standard for graph embeddings;
      brief acknowledges this can be tuned per-model. */
  embedding vector(128) NOT NULL,

  /** Embedding dimensionality. Stored alongside so application code
      can sanity-check vs the column's declared dim — defends against
      a future migration to a different dim while old rows persist. */
  embedding_dim integer NOT NULL DEFAULT 128,

  /** Identifier of the model that produced this embedding. e.g.
      'graphsage_2026_05_v1'. Tracks deployment versions so the
      retrieval layer can prefer the latest. */
  model_version text NOT NULL,

  /** When the model that produced this row was trained. Distinct
      from created_at — useful for "embeddings older than N days
      are stale" queries during iterative training. */
  trained_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),

  /** One row per (entity, kind, model_version). Re-running training
      with a new model_version creates new rows; old versions persist
      briefly during deployment for rollback. */
  UNIQUE (entity_slug, embedding_kind, model_version)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_embeddings_slug_idx
  ON entity_embeddings (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_embeddings_kind_idx
  ON entity_embeddings (embedding_kind);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_embeddings_model_version_idx
  ON entity_embeddings (model_version);
--> statement-breakpoint

-- HNSW with cosine distance — production-standard ANN index. Brief
-- spec calls for vector_cosine_ops; we use it explicitly so the
-- index is committed regardless of pgvector default changes.
CREATE INDEX IF NOT EXISTS entity_embeddings_hnsw_idx
  ON entity_embeddings USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

-- ─── Signal embeddings ────────────────────────────────────────────
-- Per brief §4.2: signals come from many source tables. Rather than
-- adding a vector column on every signal-source table, we store
-- embeddings on a single denormalized table keyed by
-- (signal_id, signal_source). Sources include 'news_event',
-- 'customs_import', 'fuel_consumption_signal', etc. Query patterns
-- in catalog/queries.ts join back to the source table by id.

CREATE TABLE IF NOT EXISTS signal_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** ID of the source row in its respective table. Text not uuid
      because some signal sources use bigserial / int IDs. */
  signal_id text NOT NULL,
  /** Which table this signal came from. e.g. 'entity_news_events',
      'customs_imports', 'fuel_consumption_signals'. */
  signal_source text NOT NULL,

  /** Embedding kind. 'text_v1' for content-text-derived,
      'graph_v1' for graph-context-derived. */
  embedding_kind text NOT NULL,
  embedding vector(128) NOT NULL,
  model_version text NOT NULL,
  trained_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),

  UNIQUE (signal_id, signal_source, embedding_kind, model_version)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signal_embeddings_signal_idx
  ON signal_embeddings (signal_id, signal_source);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signal_embeddings_kind_idx
  ON signal_embeddings (embedding_kind);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signal_embeddings_hnsw_idx
  ON signal_embeddings USING hnsw (embedding vector_cosine_ops);
