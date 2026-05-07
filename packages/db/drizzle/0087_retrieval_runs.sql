-- Audit log for reranker runs. Every time we call BGE-reranker (or
-- any future reranker) over a candidate set of passages, we record
-- the query, the candidate count, the IDs we kept, and the model
-- version. Powers debugging ("why did the drafter use THIS evidence
-- and not THAT one") and offline eval ("did rerank-v2 win over
-- rerank-v1 on the last 1k outreach drafts").
--
-- Scores are NOT stored on the row — the reranker score for a given
-- (query, passage) pair shouldn't leak into outbound copy or the
-- operator's chip preview. If we need scores for offline tuning,
-- we can add a sibling `retrieval_run_passages` table later.

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* What the reranker was answering. Free text — operator intent
     ("introduce + ask about Q3 jet supply"), an entity slug ("look
     up Cartagena refinery"), or any other phrase. */
  query text NOT NULL,

  /* Total candidate passages scored. */
  candidate_count integer NOT NULL,

  /* IDs of the passages the reranker selected (top-K). Free text:
     could be entity_web_pages.id, message ids, web_summary
     section_kinds, etc. — caller chooses the namespace. */
  selected_ids jsonb NOT NULL DEFAULT '[]'::jsonb,

  /* Reranker model used. 'bge-reranker-v2-m3' for v1; pinned per row
     so a future model swap doesn't invalidate older audit reads. */
  model_version text NOT NULL,

  /* Caller context — approval_id, source_kind, intent, etc. Free
     JSONB so producers stamp whatever they need without migration. */
  context jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS retrieval_runs_created_idx
  ON retrieval_runs (created_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS retrieval_runs_model_idx
  ON retrieval_runs (model_version);
