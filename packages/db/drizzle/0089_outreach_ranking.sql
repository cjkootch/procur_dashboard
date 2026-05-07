-- Outreach feature snapshots + outcome labels + predictions —
-- foundation for the LightGBM reply-within-14-days classifier per
-- the ML brief.
--
-- Two tables:
--   1. outreach_feature_snapshots — per-approval feature vector
--      captured AT PROPOSAL TIME so the model trains on the same
--      signals that were available when the operator approved.
--      Labels (replied / meeting / converted / disqualified) are
--      stamped in-place as outcome events fire post-approval.
--   2. outreach_predictions — model inference history. One row
--      per (approval, model_version) so we can A/B evaluate model
--      versions retroactively.
--
-- Discipline (per Cole's brief):
--   * ML ranks — it does NOT send. The approval gate is mandatory.
--   * Predictions are INTERNAL — never surface in operator-facing
--     copy or chip previews.
--   * Heuristics remain the fallback path until label volume is
--     sufficient (~500 labels for the reply-14d classifier).

CREATE TABLE IF NOT EXISTS outreach_feature_snapshots (
  /* One snapshot per approval. Foreign-key shape kept loose because
     approvals.id is text. */
  approval_id text PRIMARY KEY,

  /* Snapshot features as a flat JSONB map. Schema is documented in
     packages/ai/src/outreach/features.ts; freeform here so new
     features slot in without a migration. */
  features jsonb NOT NULL,

  /* Versions the feature vector. Bump when feature shape changes
     so trained models can refuse to score against an incompatible
     vector. */
  feature_version text NOT NULL DEFAULT 'v1',

  /* Outcome labels — null until the relevant lifecycle event fires
     post-approval. The reply-14d classifier reads
     `replied_within_14d` (computed from outreach.replied verb
     timing). The other labels are placeholders for future
     classifiers. */
  replied_within_14d boolean,
  meeting_booked boolean,
  converted_to_lead boolean,
  converted_to_deal boolean,
  disqualified boolean,

  /* When did the labels get stamped? Used for "labels older than
     14 days are final" cutoff in training. */
  labels_updated_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS outreach_feature_snapshots_replied_idx
  ON outreach_feature_snapshots (replied_within_14d)
  WHERE replied_within_14d IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS outreach_feature_snapshots_created_idx
  ON outreach_feature_snapshots (created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS outreach_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  approval_id text NOT NULL,

  /* Which model produced this prediction; pinned so historical rows
     don't get attributed to a future retrained model. */
  model_version text NOT NULL,

  /* Probability of replied_within_14d in [0, 1]. NULL when the
     model couldn't score (missing features, etc). Internal only. */
  prob_reply_14d double precision,

  /* Optional auxiliary outputs — feature attributions, top
     contributors, etc. Freeform JSONB. */
  details jsonb NOT NULL DEFAULT '{}'::jsonb,

  predicted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS outreach_predictions_approval_idx
  ON outreach_predictions (approval_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS outreach_predictions_model_idx
  ON outreach_predictions (model_version, predicted_at DESC);
