-- Lead-form sub-address tokens for reply attribution.
--
-- When the autopilot (or chat-driven submit_lead_form) submits a
-- counterparty's contact form, the form's email field gets filled
-- with a sub-addressed variant: hello+<token>@procur.app. Recipients
-- replying to the form-acknowledgement email send to that exact
-- plus-addressed address. The Resend inbound webhook parses the
-- token, looks up this row, and attaches the probe + target context
-- to the inbound message.
--
-- Without this layer, lead-form replies would land at the bare
-- sender address with no probe linkage — operator sees an
-- unattributed inbound and the AI auto-reply doesn't know which
-- probe's context to use.
--
-- Token: 8-char base32 (lowercase a-z + 2-7), random — 32^8 = 1.1
-- trillion, collision-safe at any realistic submission volume.
-- Tokens are immutable; last_seen_at gets touched on inbound match.
--
-- Operator dependency: Resend inbound config must accept
-- hello+*@procur.app (catch-all on the domain or pattern listener).

CREATE TABLE IF NOT EXISTS lead_form_submission_tokens (
  token text PRIMARY KEY,

  probe_id text NOT NULL,
  target_id text NOT NULL,
  entity_slug text NOT NULL,
  form_url text NOT NULL,
  approval_id text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS lead_form_submission_tokens_probe_idx
  ON lead_form_submission_tokens (probe_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS lead_form_submission_tokens_target_idx
  ON lead_form_submission_tokens (target_id);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS lead_form_submission_tokens_entity_idx
  ON lead_form_submission_tokens (entity_slug);
