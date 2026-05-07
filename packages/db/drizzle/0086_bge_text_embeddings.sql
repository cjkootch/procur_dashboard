-- Polymorphic BGE-M3 text embeddings — multilingual retrieval layer
-- alongside the existing OpenAI text-embedding-3-small embeddings.
--
-- Why a separate table from `entity_text_embeddings`:
--   1. BGE-M3 ships 1024-dim dense vectors; OpenAI's text-embedding-3-
--      small is 1536-dim. pgvector requires fixed dim per column, so
--      they can't share a column.
--   2. BGE-M3 covers multiple owner types (entity / message / document /
--      web_summary / web_fact / lead / deal_note / opportunity) — the
--      entity-only constraint of `entity_text_embeddings` is too narrow.
--
-- Coexists with the OpenAI embeddings; producers choose which model
-- to compute against per the procur-ml-layer-brief.md philosophy of
-- "two distinct embedding spaces, never mix similarity calcs."
--
-- Owner shape: `(owner_type, owner_id)` — owner_id is text so it
-- accepts known_entities.slug, external_suppliers.id (UUID), message
-- ids, deal_room_links subject_id, etc. The catalog layer dispatches
-- per owner_type.

CREATE TABLE IF NOT EXISTS bge_text_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* What this embedding describes. Owner_type is free text so new
     subjects (loi / icpo / assay / contact) slot in without migration.
     Owner_id is text — accepts slugs and UUIDs alike. */
  owner_type text NOT NULL,
  owner_id text NOT NULL,

  /* Composition recipe — same convention as
     entity_text_embeddings.embedding_kind. Examples: 'name',
     'name_plus_aliases', 'web_summary_overview', 'message_body',
     'deal_note_v1', 'combined_v1'. Free text; new compositions
     slot in additively. */
  embedding_kind text NOT NULL,

  /* BGE-M3 dense output is 1024-dim. Sparse + multi-vector outputs
     are out of scope for v1; revisit when query throughput justifies
     the storage. */
  embedding vector(1024) NOT NULL,

  /* What text was embedded — audit trail for "why this match" and
     for re-embedding when the model upgrades. */
  source_text text NOT NULL,

  /* Optional content hash so producers can skip re-computing rows
     whose source text hasn't changed. Sha256 hex of source_text. */
  content_hash text,

  /* Detected language (ISO 639-1) — useful for filtering /
     re-embedding by language. Nullable when detection is uncertain. */
  language text,

  /* Embedding model identifier — defaults to bge-m3 but pinned per
     row so a future model swap doesn't silently mix vector spaces. */
  model_version text NOT NULL DEFAULT 'bge-m3',

  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bge_text_embeddings_owner_idx
  ON bge_text_embeddings (owner_type, owner_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bge_text_embeddings_kind_idx
  ON bge_text_embeddings (embedding_kind);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bge_text_embeddings_language_idx
  ON bge_text_embeddings (language)
  WHERE language IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bge_text_embeddings_hnsw_idx
  ON bge_text_embeddings
  USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS bge_text_embeddings_uniq_idx
  ON bge_text_embeddings (owner_type, owner_id, embedding_kind, model_version);
