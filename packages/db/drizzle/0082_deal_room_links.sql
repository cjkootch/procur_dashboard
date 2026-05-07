-- Deal-room linkage + commercial-protection columns. Powers
-- /deals/[id] (the deal room): touchpoints + assistant_threads can
-- now point at a fuel_deal so the room aggregates everything keyed
-- by deal id, and fuel_deals carries NDA + fee-protection state for
-- the broker-protection workflow.
--
-- Idempotent — uses ADD COLUMN IF NOT EXISTS so a partial-failure
-- replay is safe (Neon HTTP is auto-commit per call).

-- touchpoints.deal_id — nullable text FK-style. Not declared as a
-- foreign-key because fuel_deals.id is text (ULID) and touchpoints
-- already supports polymorphic linkage via metadata; keeping it as
-- a plain text + index avoids a hard FK with cascade implications
-- when a deal is reassigned.
ALTER TABLE touchpoints
  ADD COLUMN IF NOT EXISTS deal_id text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS touchpoints_deal_idx ON touchpoints (deal_id)
  WHERE deal_id IS NOT NULL;
--> statement-breakpoint

-- assistant_threads.deal_id — same shape. Lets the operator (or the
-- propose_attach_to_deal chat tool) pin a chat conversation to a
-- specific deal so the deal-room "Assistant chats" tab finds it.
ALTER TABLE assistant_threads
  ADD COLUMN IF NOT EXISTS deal_id text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS assistant_threads_deal_idx ON assistant_threads (deal_id)
  WHERE deal_id IS NOT NULL;
--> statement-breakpoint

-- Commercial-protection state on fuel_deals. Mirrors the broker-
-- workflow audit (#4 + #15 + #16 from Cole's prioritization notes):
-- nothing should disclose buyer/seller identity until protection is
-- in place, and the deal-room compliance tab needs to show this at
-- a glance.
ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS nda_signed_at timestamptz;
--> statement-breakpoint

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS nda_counterparty_org_id uuid;
--> statement-breakpoint

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS fee_protection_status text;
--> statement-breakpoint

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS fee_protection_provider_org_id uuid;
--> statement-breakpoint

ALTER TABLE fuel_deals
  ADD COLUMN IF NOT EXISTS disclosure_allowed boolean NOT NULL DEFAULT false;
