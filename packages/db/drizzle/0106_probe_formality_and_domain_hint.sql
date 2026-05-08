-- Per-probe drafter steering: formality_level + domain_hint.
--
-- The base drafter prompt is "professional, single ask" — fits most
-- US/EU procurement contexts. For experimental probes outside that
-- shape (cross-border M&A first-contact, succession-stage outreach
-- to family-owned businesses, warm-market follow-ups) the operator
-- needs to shift the register and add domain framing the base
-- prompt can't infer.
--
-- formality_level — three operator-set values: 'high' (deferential,
-- honorifics, indirect ask), 'professional' (default), 'casual'
-- (warm-market). Null falls back to professional.
--
-- domain_hint — free-text guidance threaded into the drafter prompt
-- alongside the operator's intent. Captures domain-specific framing
-- the base prompt can't infer. Null = no extra framing.
--
-- Both columns are additive + nullable. Existing probes keep using
-- the base prompt unchanged.

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS formality_level text;

--> statement-breakpoint

ALTER TABLE market_probes
  ADD COLUMN IF NOT EXISTS domain_hint text;
