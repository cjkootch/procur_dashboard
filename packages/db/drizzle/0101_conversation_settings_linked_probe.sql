-- Phase 2I.2: link conversation_settings to a market probe.
--
-- When the autopilot sends to a contact, it upserts a
-- conversation_settings row with linked_probe_id set. The reply path
-- (maybeQueueAiEmailReply / maybeQueueAiReply) reads this column to:
--
--   1. Apply probe-tier-aware approvalMode at draft time (probe.tier 1
--      → approvalMode='tiered'; tier 0 → 'full_approval'). This
--      replaces the channel-default approval that runs for non-probe
--      replies.
--
--   2. Run the probe-aware escalation classifier on inbound bodies —
--      auto-pause + notify operator when the recipient asks for price
--      / buyer name / shows commercial interest / raises legal
--      concerns. Without this, a successful probe reply would
--      auto-respond to "what's your price?" via the existing tiered
--      flow.
--
-- linked_lead_id / linked_deal_id / linked_entity_slug already exist
-- as conversation pointers. linked_probe_id slots in as the fourth.

ALTER TABLE conversation_settings
  ADD COLUMN IF NOT EXISTS linked_probe_id text;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS conversation_settings_linked_probe_id_idx
  ON conversation_settings(linked_probe_id)
  WHERE linked_probe_id IS NOT NULL;
