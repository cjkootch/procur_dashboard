import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  entityContactFormEndpoints,
  type EntityContactFormEndpoint,
  type FormField,
  type NewEntityContactFormEndpoint,
} from '@procur/db';

/**
 * Read/write helpers for entity_contact_form_endpoints (migration
 * 0103). Two writers: (a) the crawl-entity-website agent's
 * form-detection pass, and (b) the operator-manual-add UI path on
 * the entity profile. One reader: the autopilot's lead_form executor
 * at dispatch time.
 *
 * Discipline mirrored on every helper:
 *   - autopilotEligible(row) is the SINGLE function consumers use to
 *     decide "can the autopilot submit this?" — keeps the rule (no
 *     CAPTCHA, http_post, has message_field) in one place.
 *   - upsert is idempotent on (entity_slug, url) — re-crawls + manual
 *     edits both flow through the same insert with on-conflict
 *     update; the crawler doesn't blow away operator-supplied field
 *     resolutions.
 */

export type { EntityContactFormEndpoint, FormField };

export interface UpsertFormEndpointInput {
  entitySlug: string;
  url: string;
  submitMethod?: 'http_post' | 'js_only' | 'unknown';
  detectedCaptchaKind?: string | null;
  fields?: FormField[];
  nameField?: string | null;
  emailField?: string | null;
  subjectField?: string | null;
  messageField?: string | null;
  companyField?: string | null;
  phoneField?: string | null;
  language?: string | null;
  source: 'crawler' | 'operator';
}

export async function upsertFormEndpoint(
  input: UpsertFormEndpointInput,
): Promise<EntityContactFormEndpoint> {
  const row: NewEntityContactFormEndpoint = {
    entitySlug: input.entitySlug,
    url: input.url,
    submitMethod: input.submitMethod ?? 'unknown',
    detectedCaptchaKind: input.detectedCaptchaKind ?? null,
    fields: input.fields ?? [],
    nameField: input.nameField ?? null,
    emailField: input.emailField ?? null,
    subjectField: input.subjectField ?? null,
    messageField: input.messageField ?? null,
    companyField: input.companyField ?? null,
    phoneField: input.phoneField ?? null,
    language: input.language ?? null,
    source: input.source,
    lastVerifiedAt: new Date(),
  };
  // On-conflict update: crawler-discovered shape refreshes captcha
  // detection + field map, BUT preserves operator-set field role
  // resolutions (the operator may have manually fixed a misidentified
  // message_field; the crawler shouldn't clobber that). Operator
  // updates always win — they pass source='operator' and bypass the
  // COALESCE.
  const isOperator = input.source === 'operator';
  const [created] = await db
    .insert(entityContactFormEndpoints)
    .values(row)
    .onConflictDoUpdate({
      target: [
        entityContactFormEndpoints.entitySlug,
        entityContactFormEndpoints.url,
      ],
      set: {
        submitMethod: sql`excluded.submit_method`,
        detectedCaptchaKind: sql`excluded.detected_captcha_kind`,
        fields: sql`excluded.fields`,
        // Field-role resolutions: operator value wins; otherwise keep
        // existing if non-null, else take the new one.
        nameField: isOperator
          ? sql`excluded.name_field`
          : sql`COALESCE(${entityContactFormEndpoints.nameField}, excluded.name_field)`,
        emailField: isOperator
          ? sql`excluded.email_field`
          : sql`COALESCE(${entityContactFormEndpoints.emailField}, excluded.email_field)`,
        subjectField: isOperator
          ? sql`excluded.subject_field`
          : sql`COALESCE(${entityContactFormEndpoints.subjectField}, excluded.subject_field)`,
        messageField: isOperator
          ? sql`excluded.message_field`
          : sql`COALESCE(${entityContactFormEndpoints.messageField}, excluded.message_field)`,
        companyField: isOperator
          ? sql`excluded.company_field`
          : sql`COALESCE(${entityContactFormEndpoints.companyField}, excluded.company_field)`,
        phoneField: isOperator
          ? sql`excluded.phone_field`
          : sql`COALESCE(${entityContactFormEndpoints.phoneField}, excluded.phone_field)`,
        language: sql`COALESCE(excluded.language, ${entityContactFormEndpoints.language})`,
        source: isOperator ? sql`'operator'::text` : sql`${entityContactFormEndpoints.source}`,
        lastVerifiedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!created) throw new Error('upsertFormEndpoint: no row returned');
  return created;
}

export async function listFormEndpointsForEntity(
  entitySlug: string,
): Promise<EntityContactFormEndpoint[]> {
  return await db
    .select()
    .from(entityContactFormEndpoints)
    .where(eq(entityContactFormEndpoints.entitySlug, entitySlug))
    .orderBy(desc(entityContactFormEndpoints.lastVerifiedAt));
}

/**
 * Pick the best autopilot-eligible endpoint for a target. Returns
 * null when the entity has no eligible form (no rows, all CAPTCHA-
 * protected, all js_only, or none have a message_field set).
 *
 * Selection rule when multiple eligible: prefer endpoints with the
 * most field-role resolutions filled (better drafter shape), then
 * most recently verified.
 */
export async function pickAutopilotEligibleEndpoint(
  entitySlug: string,
): Promise<EntityContactFormEndpoint | null> {
  const rows = await db
    .select()
    .from(entityContactFormEndpoints)
    .where(
      and(
        eq(entityContactFormEndpoints.entitySlug, entitySlug),
        isNull(entityContactFormEndpoints.detectedCaptchaKind),
        eq(entityContactFormEndpoints.submitMethod, 'http_post'),
      ),
    );
  if (rows.length === 0) return null;
  const eligible = rows.filter((r) => Boolean(r.messageField));
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const aFields =
      [a.nameField, a.emailField, a.subjectField, a.companyField].filter(
        Boolean,
      ).length;
    const bFields =
      [b.nameField, b.emailField, b.subjectField, b.companyField].filter(
        Boolean,
      ).length;
    if (aFields !== bFields) return bFields - aFields;
    const aT = a.lastVerifiedAt?.getTime() ?? 0;
    const bT = b.lastVerifiedAt?.getTime() ?? 0;
    return bT - aT;
  });
  return eligible[0] ?? null;
}

/**
 * Single-rule check that consumers (autopilot eligibility filter,
 * dashboard "submittable" badge) call to decide whether a row is
 * autopilot-eligible. Centralizing the rule prevents drift between
 * call sites.
 */
export function autopilotEligible(
  row: EntityContactFormEndpoint,
): boolean {
  return (
    row.detectedCaptchaKind == null &&
    row.submitMethod === 'http_post' &&
    Boolean(row.messageField)
  );
}

export async function recordSubmissionAt(
  endpointId: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .update(entityContactFormEndpoints)
    .set({ lastSubmissionAt: at, updatedAt: new Date() })
    .where(eq(entityContactFormEndpoints.id, endpointId));
}
