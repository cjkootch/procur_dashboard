-- Flip conversation_settings.approval_mode default from
-- 'full_approval' to 'tiered'. Schema-level + catalog-helper-level
-- inserts match. Pre-#535 rows that were created at
-- 'full_approval' stay where they are — only NEW rows pick up the
-- new default.
--
-- Why: when an operator flips AI auto-reply on, the sensible
-- expectation is "auto-send the safe stuff, ask me about the
-- commitments." `full_approval` (every reply gates) defeats the
-- toggle's purpose. The right-rail UI was making operators
-- explicitly select 'tiered' every time, which is wasted clicks
-- when 99% want that mode.
--
-- 'business_hours_only' stays a manual opt-in — it has deferred
-- semantics that need explicit operator buy-in.
--
-- Existing rows are NOT migrated en masse — that would override
-- operators who deliberately picked 'full_approval' for cautious
-- conversations. Only the column default + new-row inserts change.

ALTER TABLE conversation_settings
  ALTER COLUMN approval_mode SET DEFAULT 'tiered';
