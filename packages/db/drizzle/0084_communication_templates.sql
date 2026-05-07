-- Communication templates — pre-built email / SMS / WhatsApp / call
-- bodies that the chat assistant can reference by name. Per Cole's
-- vex-parity request: build a library once, reuse in chat ("use the
-- intro template for Acme") with operator-supplied variables.
--
-- Distinct from `deal_structure_templates` (those are deal-shape
-- templates — CIF/FOB/SBLC) and from Twilio Content Templates (those
-- are managed in Twilio's dashboard; we pin to them via
-- `content_sid` for whatsapp_template kinds).
--
-- Idempotent — uses CREATE ... IF NOT EXISTS / DO blocks so a
-- partial-failure replay is safe (Neon HTTP is auto-commit per call).

DO $$ BEGIN
  CREATE TYPE communication_template_kind AS ENUM (
    'email',
    'sms',
    'whatsapp',
    'whatsapp_template',
    'call'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS communication_templates (
  id text PRIMARY KEY,
  kind communication_template_kind NOT NULL,
  /** slug — unique within kind. Operator references "use the
      `intro_refiner` email template" in chat by this name. */
  name text NOT NULL,
  /** Human-readable name shown in the settings UI + chat tool
      output. Free-form. */
  display_name text NOT NULL,
  /** Email subject line. NULL for sms/whatsapp/call kinds. Supports
      the same {{variable}} substitution as body. */
  subject text,
  /** Plain-text body. {{variable}} placeholders get substituted from
      the operator-supplied variables map at render time. */
  body text NOT NULL,
  /** For whatsapp_template kind: the Twilio Content Template SID
      (HX + 32 hex chars). Operator-managed in Twilio's console; we
      pin our internal name to it so chat can reference by friendly
      name and the executor still hits the right Content SID. */
  content_sid text,
  /** Variable manifest. Each entry: {name, description, required,
      defaultValue}. Drives the render-time validation + the chat
      tool's "missing variables" hint. */
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text,
  /** Stamped every time the template is used in a propose_*_send
      that successfully dispatches. Powers a "most-used templates"
      sort in the settings UI. */
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  /** Soft-delete — disabled templates don't show in chat lookups
      but are preserved for audit (touchpoints reference template
      names from past sends). */
  archived_at timestamptz
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS communication_templates_kind_name_uniq
  ON communication_templates (kind, name)
  WHERE archived_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS communication_templates_last_used_idx
  ON communication_templates (kind, last_used_at DESC NULLS LAST)
  WHERE archived_at IS NULL;
