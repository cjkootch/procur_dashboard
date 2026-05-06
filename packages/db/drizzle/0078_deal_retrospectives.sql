-- Pattern 5 (deal retrospectives) per docs/feedback-ui-brief.md §8.
-- Structured 5-7-minute retrospective form filled out 7+ days after
-- a vex deal closes. Powers similar-deal surfacing (Component A
-- embeddings) once embeddings are populated.
--
-- deal_id is text (not FK) because vex deals live in vex's database;
-- procur references them via vex's external dealId. UNIQUE per
-- (deal_id, user_id) so a deal can't have duplicate retrospectives
-- from the same operator.

CREATE TABLE IF NOT EXISTS deal_retrospectives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** Vex's deal id (ULID or similar) — text for cross-system safety. */
  deal_id text NOT NULL,
  user_id text NOT NULL,
  /** Outcome at the time the retrospective was generated.
      'won' | 'lost' | 'dead'. */
  deal_outcome text NOT NULL,

  /** Free-form responses to the brief §8.2 structured form fields. */
  initial_signal_source text,
  days_signal_to_close integer,
  critical_moments text,
  /** 'yes_materially' | 'yes_marginally' | 'no' | 'na'. */
  procur_insight_mattered text,
  what_would_have_helped text,
  pattern_for_future text,

  completed_at timestamp,
  is_draft boolean NOT NULL DEFAULT false,

  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),

  UNIQUE (deal_id, user_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_retrospectives_deal_idx
  ON deal_retrospectives (deal_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_retrospectives_user_idx
  ON deal_retrospectives (user_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_retrospectives_completed_idx
  ON deal_retrospectives (completed_at);
