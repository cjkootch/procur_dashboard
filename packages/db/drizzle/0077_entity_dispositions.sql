-- Pattern 4 (disposition tracking) per docs/feedback-ui-brief.md §7.
-- Append-only history of (user, entity) disposition transitions.
-- The latest non-superseded row per (user, entity) is the current
-- disposition; the current_dispositions view materializes that.
--
-- Distinct from supplier_approvals (KYC status) — disposition is
-- the analyst's commercial-pursuit state ("active pursuing" vs
-- "dormant" vs "dead"); approvals are KYC/contract gates. Both
-- attach to (company, entity_slug) but mean different things.

CREATE TABLE IF NOT EXISTS entity_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** known_entities.slug or external_suppliers.id (UUID) — same
      canonical-key shape elsewhere. */
  entity_slug text NOT NULL,
  user_id text NOT NULL,
  /** 'active_pursuing' | 'active_exploratory' | 'dormant' | 'dead'
      | 'declined' | 'never_contacted'. Free text; new values land
      without migration. */
  disposition text NOT NULL,
  /** Required when disposition = 'declined'; null otherwise. */
  decline_reason text,
  set_at timestamp NOT NULL DEFAULT now(),
  /** Set when a newer row supersedes this one. The current
      disposition for an (entity, user) pair is the row WHERE
      superseded_at IS NULL. */
  superseded_at timestamp
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_dispositions_entity_idx
  ON entity_dispositions (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_dispositions_user_idx
  ON entity_dispositions (user_id);
--> statement-breakpoint

-- Partial index on the current row per (entity, user) — the heavy
-- query path is "what's this user's current disposition for this
-- entity?" which this serves directly.
CREATE INDEX IF NOT EXISTS entity_dispositions_current_idx
  ON entity_dispositions (entity_slug, user_id)
  WHERE superseded_at IS NULL;
--> statement-breakpoint

-- Convenience view for current dispositions. Latest set_at per
-- (entity, user). Read-mostly; updated implicitly via the
-- supersession machinery in setEntityDisposition.
CREATE OR REPLACE VIEW current_dispositions AS
SELECT DISTINCT ON (entity_slug, user_id)
    entity_slug, user_id, disposition, decline_reason, set_at
  FROM entity_dispositions
 WHERE superseded_at IS NULL
 ORDER BY entity_slug, user_id, set_at DESC;
