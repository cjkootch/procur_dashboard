-- Lead-form outreach channel for Market Probes.
--
-- Adds entity_contact_form_endpoints — discovered or
-- operator-supplied contact-form endpoints per known_entity.
-- Populated by the crawl-entity-website agent's form-detection pass
-- and by manual operator add (entity profile UI). Read by the
-- autopilot's lead_form executor at dispatch time.
--
-- Submission discipline: this table is the single source of truth on
-- whether a target's contact form is autopilot-eligible. Discovery
-- detects anti-bot mechanisms and stamps detected_captcha_kind; the
-- executor refuses to POST against any endpoint where that column is
-- non-null OR submit_method is anything other than 'http_post'.
-- CAPTCHA-protected forms fall out of the lead_form channel for that
-- target — email channel stays available regardless. We do NOT bypass
-- CAPTCHA.

CREATE TABLE IF NOT EXISTS entity_contact_form_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- known_entities.slug OR external_suppliers.id
  entity_slug text NOT NULL,

  -- the form's action URL (POST target)
  url text NOT NULL,

  -- 'http_post' | 'js_only' | 'unknown'
  submit_method text NOT NULL DEFAULT 'unknown',

  -- null | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile'
  --      | 'honeypot' | 'cloudflare' | 'unknown'
  detected_captcha_kind text,

  -- array of { name, type, label?, required, options?, autocomplete? }
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- field-name resolutions for canonical roles. nullable — discovery
  -- may not identify; operator can set manually.
  name_field text,
  email_field text,
  subject_field text,
  message_field text,
  company_field text,
  phone_field text,

  -- ISO-639 language hint (from page <html lang=> or detected)
  language text,

  -- last successful discovery / verification
  last_verified_at timestamptz,

  -- last autopilot submission (per-domain cooldown enforcement)
  last_submission_at timestamptz,

  -- 'crawler' (auto-discovered) | 'operator' (manually added)
  source text NOT NULL DEFAULT 'crawler',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS entity_contact_form_endpoints_dedup_idx
  ON entity_contact_form_endpoints (entity_slug, url);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_contact_form_endpoints_entity_idx
  ON entity_contact_form_endpoints (entity_slug);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_contact_form_endpoints_captcha_idx
  ON entity_contact_form_endpoints (detected_captcha_kind);
