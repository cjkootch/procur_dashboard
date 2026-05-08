import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Discovered lead-form endpoints per known_entity. Populated by the
 * crawl-entity-website agent's form-detection pass and by the
 * operator's manual add (entity profile UI). Read by the autopilot's
 * lead_form executor at dispatch time.
 *
 * Submission discipline: this table is the SINGLE source of truth on
 * whether a target's contact form is autopilot-eligible. Discovery
 * detects anti-bot mechanisms and stamps `detected_captcha_kind`;
 * the executor refuses to POST against any endpoint where
 * `detected_captcha_kind` is non-null OR `submit_method` is anything
 * other than 'http_post'. We do NOT bypass CAPTCHA — protected forms
 * fall out of the lead_form channel for that target. Email channel
 * stays available regardless.
 *
 * Idempotent on (entity_slug, url) — re-crawls update field shape +
 * captcha detection without duplicating rows.
 */
export const entityContactFormEndpoints = pgTable(
  'entity_contact_form_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** known_entities.slug OR external_suppliers.id (same shape that
        getEntityProfile accepts). */
    entitySlug: text('entity_slug').notNull(),

    /** The form's `action` URL (or the page URL if action is omitted /
        relative-resolved). Used as the POST target. */
    url: text('url').notNull(),

    /** 'http_post' — standard form POST, autopilot-eligible.
        'js_only' — form requires JS to submit (e.g., handler attached
                    to a button that calls fetch from a SPA bundle);
                    autopilot can't reliably submit without a real
                    browser. Skipped.
        'unknown' — discovery couldn't determine; treat as ineligible. */
    submitMethod: text('submit_method').notNull().default('unknown'),

    /** Anti-bot mechanism detected at discovery, if any.
        null         — no detection, autopilot may submit
        'recaptcha_v2' / 'recaptcha_v3' / 'hcaptcha' / 'turnstile'
                     — Google / Cloudflare / hCaptcha widget present
        'honeypot'   — hidden field detected with form-relevant name
        'cloudflare' — CF challenge page in front of the form URL
        'unknown'    — anti-bot signal we couldn't classify

        Autopilot refuses to submit when this is non-null. */
    detectedCaptchaKind: text('detected_captcha_kind'),

    /** Field map — array of { name, type, label?, required, options? }.
        The drafter reads this to know which fields to populate; the
        executor uses it to format the POST body. */
    fields: jsonb('fields').$type<FormField[]>().notNull().default(sql`'[]'::jsonb`),

    /** Field-name resolutions for the four canonical roles.
     *  Discovery infers these from name / label / autocomplete
     *  attributes; operator can override from the entity-profile UI.
     *  Null means the form has no such field (e.g., no subject input)
     *  or discovery couldn't identify it (operator must set manually
     *  before this endpoint is autopilot-eligible). */
    nameField: text('name_field'),
    emailField: text('email_field'),
    subjectField: text('subject_field'),
    messageField: text('message_field'),
    companyField: text('company_field'),
    phoneField: text('phone_field'),

    /** ISO-639 language hint for the form (from page <html lang=> or
     *  detected). Drafter uses this to localize the message body when
     *  conversation_settings.language is 'auto'. */
    language: text('language'),

    /** Last successful discovery / verification pass. Re-crawl skips
     *  endpoints verified within the last 90 days unless --refresh. */
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),

    /** Last autopilot submission timestamp. Used by the executor to
     *  enforce per-domain cooldowns (don't hammer the same form). */
    lastSubmissionAt: timestamp('last_submission_at', { withTimezone: true }),

    /** Source of the row — 'crawler' (auto-discovered) or 'operator'
     *  (manually added via entity profile UI). Operator-added rows
     *  trust the field map without re-crawling. */
    source: text('source').notNull().default('crawler'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupIdx: uniqueIndex('entity_contact_form_endpoints_dedup_idx').on(
      table.entitySlug,
      table.url,
    ),
    entityIdx: index('entity_contact_form_endpoints_entity_idx').on(
      table.entitySlug,
    ),
    captchaIdx: index('entity_contact_form_endpoints_captcha_idx').on(
      table.detectedCaptchaKind,
    ),
  }),
);

export interface FormField {
  /** HTML `name` attribute. */
  name: string;
  /** HTML `type` attribute — 'text' / 'email' / 'tel' / 'textarea' /
   *  'select' / 'checkbox' / 'hidden' / etc. */
  type: string;
  /** Label text (from <label for=> association or aria-label) when
   *  detected. */
  label?: string;
  required: boolean;
  /** For 'select' / 'radio' / 'checkbox' fields with a fixed option
   *  set — the values discovery saw. Drafter uses these to pick
   *  appropriate values when the field is required. */
  options?: string[];
  /** autocomplete attribute, when present (helps role inference). */
  autocomplete?: string;
}

export type EntityContactFormEndpoint =
  typeof entityContactFormEndpoints.$inferSelect;
export type NewEntityContactFormEndpoint =
  typeof entityContactFormEndpoints.$inferInsert;
