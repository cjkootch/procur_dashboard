-- Per-probe opt-in for paid Apollo phone enrichment during
-- autopilot RVM dispatch.
--
-- The autopilot's RVM channel needs a phone number for the target.
-- Cheap path: phone is already on file (rolodex contact, prior
-- enrichment cache). When it isn't and this flag is true, the
-- autopilot may trigger Apollo's enrichPerson endpoint on demand —
-- a paid call that counts against the tenant's daily credit cap.
-- When false (default), targets without a cached phone are silently
-- skipped on the RVM channel (the autopilot falls through to the
-- next channel: lead_form, or no-op).
--
-- Default false on purpose: autopilot RVM is opt-in per probe, and
-- RVM-with-paid-enrichment is opt-in within that. Operators flipping
-- this on is the explicit signal that the probe's hypothesis warrants
-- the spend.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS allow_paid_enrichment boolean NOT NULL DEFAULT false;
