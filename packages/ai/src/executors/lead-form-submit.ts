import { eq } from 'drizzle-orm';
import {
  approvals,
  contacts,
  db,
  entityContactFormEndpoints,
  events,
  touchpoints,
} from '@procur/db';
import { createId } from '../agents/id';
import type { MlEvidenceT } from '../agents/action-descriptor';
import { PostgresCostLedger } from '../cost-ledger';
import {
  buildOutreachMetadata,
  type OutreachEvidence,
} from './outreach-evidence';

/**
 * lead_form.submit executor — closes the autopilot + chat-assistant
 * approval-queue loop for the website lead-form outreach channel.
 *
 * When a `lead_form.submit` approval flips to `approved` (or
 * `auto_approved`), this verifies eligibility live, performs an HTTP
 * POST to the form's action URL, parses the response heuristically
 * for success/failure, writes a `lead_form.submitted` touchpoint,
 * records the per-submission cost ledger entry, and stamps
 * `applied_object_id` + `applied_at` on the approval row.
 *
 * Submission discipline (load-bearing):
 *   - Re-verifies autopilot eligibility live: refuses to POST when
 *     detected_captcha_kind is non-null OR submit_method is anything
 *     other than 'http_post'. Discovery may have stamped the captcha
 *     kind days before the approval lands; we re-check at dispatch
 *     time so a freshly-CAPTCHA-protected form doesn't get hit.
 *   - When eligibility check fails at dispatch time, we DO NOT
 *     bypass — we return `ok: false` with a clear reason. The
 *     calling autopilot rolls the target back to `pending` so
 *     another channel (email) can still serve it.
 *   - Realistic headers (User-Agent, Referer, Accept-Language) so
 *     legitimate forms don't 403 us as an obvious bot. NOT for
 *     bypassing detection — for not getting blocked by overzealous
 *     server-side filters that flag missing UA strings as automated.
 *   - Per-domain cooldown via last_submission_at: refuse to POST
 *     against the same endpoint twice within 60 seconds. Belt-and-
 *     braces against autopilot batching that might otherwise hammer
 *     a single domain.
 *
 * Idempotent: if applied_at is already set on the approval, the
 * executor is a no-op. The HTTP POST itself isn't idempotent
 * server-side (a contact form will accept duplicate submissions),
 * so the approval-state guard is the ONLY thing preventing a retry
 * from double-submitting.
 */

export interface LeadFormSubmitPayload {
  /** known_entities.slug OR external_suppliers.id — the entity whose
   *  contact form we're submitting against. Used to fetch the
   *  endpoint row at dispatch time (re-verifies live eligibility). */
  entitySlug: string;
  /** The form's action URL. Must match an entity_contact_form_endpoints
   *  row for this entitySlug. */
  formUrl: string;
  /** Field-name → value map. Pre-resolved by the drafter (PR 4) using
   *  the endpoint's field-role columns. The executor passes these
   *  straight through to the POST body without further interpretation. */
  fieldValues: Record<string, string>;
  /** The drafter's structured payload (separate fields for audit /
   *  re-render). The executor doesn't re-derive fieldValues from
   *  this — the drafter's pass already mapped roles to field names. */
  draftedFields?: {
    name?: string;
    email?: string;
    subject?: string;
    message?: string;
    company?: string;
    phone?: string;
  };
  /** Optional contact id for touchpoint linkage. */
  contactId?: string;
  /** Operator rationale captured at proposal time. */
  rationale?: string;
  /** Recommendation-pipeline evidence pack — same shape email uses. */
  evidenceJson?: Record<string, unknown>;
  mlEvidence?: MlEvidenceT;
  sourceEntitySlug?: string;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  riskWarnings?: string[];
  doNotMention?: string[];
}

export interface LeadFormSubmitResult {
  ok: boolean;
  /** HTTP status code from the POST when we got that far; null when
   *  we refused before submitting. */
  httpStatus?: number | null;
  /** Touchpoint id when ok=true. */
  touchpointId?: string;
  /** Reason / error string. Surfaced in the dashboard. */
  error?: string;
  /** True when we declined to submit because eligibility check
   *  failed at dispatch time (captcha appeared since discovery / form
   *  flipped to js_only / cooldown not elapsed). Distinguishes
   *  "we wouldn't try" from "we tried and it failed" so the
   *  autopilot can roll back the target to `pending` cleanly. */
  refusedAtDispatch?: boolean;
}

export interface LeadFormSubmitOptions {
  companyId?: string;
}

/**
 * Parse a stored approval payload into a LeadFormSubmitPayload. Used
 * by the dispatcher when an operator approves a `lead_form.submit`
 * action proposed via the chat tool. Mirrors parseEmailSendPayload's
 * shape — returns null when the payload doesn't match the expected
 * structure so the dispatcher can no-op rather than throw.
 */
export function parseLeadFormSubmitPayload(
  raw: Record<string, unknown>,
): LeadFormSubmitPayload | null {
  const entitySlug =
    typeof raw['entitySlug'] === 'string'
      ? raw['entitySlug']
      : typeof raw['entity_slug'] === 'string'
        ? (raw['entity_slug'] as string)
        : null;
  const formUrl =
    typeof raw['formUrl'] === 'string'
      ? raw['formUrl']
      : typeof raw['form_url'] === 'string'
        ? (raw['form_url'] as string)
        : null;
  const fieldValuesRaw =
    raw['fieldValues'] ?? raw['field_values'] ?? null;
  if (!entitySlug || !formUrl) return null;
  if (typeof fieldValuesRaw !== 'object' || fieldValuesRaw == null) return null;
  const fieldValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldValuesRaw as Record<string, unknown>)) {
    if (typeof v === 'string') fieldValues[k] = v;
  }
  if (Object.keys(fieldValues).length === 0) return null;
  const draftedRaw = raw['draftedFields'] ?? raw['drafted_fields'] ?? null;
  const drafted =
    typeof draftedRaw === 'object' && draftedRaw != null
      ? (draftedRaw as Record<string, unknown>)
      : {};
  return {
    entitySlug,
    formUrl,
    fieldValues,
    draftedFields: {
      name: typeof drafted['name'] === 'string' ? drafted['name'] : undefined,
      email:
        typeof drafted['email'] === 'string' ? drafted['email'] : undefined,
      subject:
        typeof drafted['subject'] === 'string' ? drafted['subject'] : undefined,
      message:
        typeof drafted['message'] === 'string' ? drafted['message'] : undefined,
      company:
        typeof drafted['company'] === 'string' ? drafted['company'] : undefined,
      phone:
        typeof drafted['phone'] === 'string' ? drafted['phone'] : undefined,
    },
    contactId:
      typeof raw['contactId'] === 'string'
        ? raw['contactId']
        : typeof raw['contact_id'] === 'string'
          ? (raw['contact_id'] as string)
          : undefined,
    rationale:
      typeof raw['rationale'] === 'string'
        ? (raw['rationale'] as string)
        : undefined,
  };
}

const PER_DOMAIN_COOLDOWN_MS = 60_000;
const POST_TIMEOUT_MS = 15_000;
const SUCCESS_TEXT_PATTERNS =
  /\b(thank\s*you|thanks|message\s*(received|sent)|we\b.*\b(received|got)\b.*\b(your|the)\b|submission\s*(received|complete|successful)|we['’]ll\s*(be in touch|get back)|merci|gracias|обращ|tak)\b/i;
const FAILURE_TEXT_PATTERNS =
  /\b(captcha|robot|bot\s*detect|please\s*verify|cloudflare|forbidden|access\s*denied|rate\s*limit|too\s*many|invalid\s*token)\b/i;

const costLedger = new PostgresCostLedger();

export async function applyLeadFormSubmit(
  approvalId: string,
  payload: LeadFormSubmitPayload,
  _options: LeadFormSubmitOptions = {},
): Promise<LeadFormSubmitResult> {
  if (!payload.entitySlug || !payload.formUrl) {
    return {
      ok: false,
      error: 'lead_form.submit payload missing entitySlug or formUrl',
    };
  }
  if (
    !payload.fieldValues ||
    Object.keys(payload.fieldValues).length === 0
  ) {
    return {
      ok: false,
      error: 'lead_form.submit payload missing fieldValues',
    };
  }

  const existing = await db
    .select({ appliedAt: approvals.appliedAt })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (existing[0]?.appliedAt) {
    return { ok: true };
  }

  // Re-verify eligibility live. Discovery may have stamped the
  // endpoint days ago; the form could have flipped to CAPTCHA-
  // protected since then. CRITICAL: this is the dispatch-time
  // safety net — without it a stale row could let us POST against
  // a now-protected form.
  const [endpoint] = await db
    .select()
    .from(entityContactFormEndpoints)
    .where(eq(entityContactFormEndpoints.url, payload.formUrl))
    .limit(1);
  if (!endpoint) {
    return {
      ok: false,
      error: `endpoint not found for url ${payload.formUrl} — operator must re-add or re-crawl`,
      refusedAtDispatch: true,
    };
  }
  if (endpoint.entitySlug !== payload.entitySlug) {
    return {
      ok: false,
      error: `endpoint url is registered to a different entity (${endpoint.entitySlug})`,
      refusedAtDispatch: true,
    };
  }
  if (endpoint.detectedCaptchaKind != null) {
    return {
      ok: false,
      error: `refusing to submit — endpoint stamped with detected_captcha_kind=${endpoint.detectedCaptchaKind}`,
      refusedAtDispatch: true,
    };
  }
  if (endpoint.submitMethod !== 'http_post') {
    return {
      ok: false,
      error: `refusing to submit — endpoint submit_method=${endpoint.submitMethod}`,
      refusedAtDispatch: true,
    };
  }
  if (!endpoint.messageField) {
    return {
      ok: false,
      error: 'refusing to submit — endpoint has no message_field set',
      refusedAtDispatch: true,
    };
  }

  // Per-domain cooldown.
  if (
    endpoint.lastSubmissionAt &&
    Date.now() - endpoint.lastSubmissionAt.getTime() < PER_DOMAIN_COOLDOWN_MS
  ) {
    return {
      ok: false,
      error: `cooldown — last submission to this endpoint was ${Math.round((Date.now() - endpoint.lastSubmissionAt.getTime()) / 1000)}s ago (${PER_DOMAIN_COOLDOWN_MS / 1000}s required)`,
      refusedAtDispatch: true,
    };
  }

  // Resolve org via contact for touchpoint linkage.
  let orgIdForTouchpoint: string | null = null;
  if (payload.contactId) {
    const [contactRow] = await db
      .select({ orgId: contacts.orgId })
      .from(contacts)
      .where(eq(contacts.id, payload.contactId))
      .limit(1);
    orgIdForTouchpoint = contactRow?.orgId ?? null;
  }

  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(payload.fieldValues)) {
    if (typeof v === 'string') formBody.append(k, v);
  }

  // Realistic headers — NOT for bypass; for not tripping
  // overzealous server-side filters that flag missing UA strings
  // as obviously-automated. Forms with actual anti-bot already got
  // filtered at the eligibility check above.
  const formUrlObj = new URL(payload.formUrl);
  const referer = `${formUrlObj.origin}${formUrlObj.pathname}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent':
      process.env.LEAD_FORM_USER_AGENT ??
      'Mozilla/5.0 (compatible; Procur-Outreach/1.0; +https://procur.app/about)',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': endpoint.language
      ? `${endpoint.language},en;q=0.7`
      : 'en-US,en;q=0.9',
    Referer: referer,
  };

  const occurredAt = new Date();
  let httpStatus: number | null = null;
  let responseBody = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(payload.formUrl, {
        method: 'POST',
        headers,
        body: formBody.toString(),
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    httpStatus = response.status;
    // Read up to 32KB of the response — enough to scan for
    // success/failure keywords without buffering full responses.
    const reader = response.body?.getReader();
    if (reader) {
      let total = 0;
      const decoder = new TextDecoder();
      while (total < 32_000) {
        const { value, done } = await reader.read();
        if (done) break;
        responseBody += decoder.decode(value, { stream: true });
        total += value?.byteLength ?? 0;
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `POST failed: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus,
    };
  }

  // Response heuristics. 2xx + a "thank you" / "received" / locale
  // equivalent in the body = success. 2xx with CAPTCHA / rate-limit
  // language = failure (form accepted the POST but didn't queue our
  // submission). 3xx redirected to a thanks-style page is treated
  // as success via the redirect chain (fetch follows redirects by
  // default; final URL hint helps but body scan dominates).
  const isHttpOk = httpStatus != null && httpStatus >= 200 && httpStatus < 400;
  const failureSignal = FAILURE_TEXT_PATTERNS.test(responseBody);
  const successSignal = SUCCESS_TEXT_PATTERNS.test(responseBody);
  const succeeded = isHttpOk && successSignal && !failureSignal;
  if (!succeeded) {
    const reason = !isHttpOk
      ? `HTTP ${httpStatus}`
      : failureSignal
        ? 'response body indicates anti-bot / failure'
        : 'response body has no success acknowledgement';
    return {
      ok: false,
      httpStatus,
      error: `submission likely rejected — ${reason}`,
    };
  }

  // Persist touchpoint + audit event + cost-ledger entry. Mirrors
  // applyEmailSend's tail; we don't need messages/threads since
  // forms are outbound-only and any reply arrives via email.
  const evidence: OutreachEvidence = {
    ...(payload.evidenceJson ? { evidenceJson: payload.evidenceJson } : {}),
    ...(payload.mlEvidence ? { mlEvidence: payload.mlEvidence } : {}),
    ...(payload.sourceEntitySlug
      ? { sourceEntitySlug: payload.sourceEntitySlug }
      : {}),
    ...(payload.sourceSignalId
      ? { sourceSignalId: payload.sourceSignalId }
      : {}),
    ...(payload.sourceOpportunityId
      ? { sourceOpportunityId: payload.sourceOpportunityId }
      : {}),
    ...(payload.riskWarnings ? { riskWarnings: payload.riskWarnings } : {}),
    ...(payload.doNotMention ? { doNotMention: payload.doNotMention } : {}),
  };

  const touchpointId = createId();
  await db.insert(touchpoints).values({
    id: touchpointId,
    contactId: payload.contactId ?? null,
    orgId: orgIdForTouchpoint,
    channel: 'lead_form',
    occurredAt,
    metadata: {
      form_url: payload.formUrl,
      entity_slug: payload.entitySlug,
      http_status: httpStatus,
      direction: 'outbound',
      drafted_fields: payload.draftedFields ?? null,
      field_names_used: Object.keys(payload.fieldValues),
      approval_id: approvalId,
      rationale: payload.rationale ?? null,
      ...buildOutreachMetadata(evidence),
    },
  });

  await db.insert(events).values({
    id: createId(),
    verb: 'lead_form.submitted',
    subjectType: 'approval',
    subjectId: approvalId,
    actorType: 'system',
    actorId: 'lead-form-submit-executor',
    objectType: 'touchpoint',
    objectId: touchpointId,
    occurredAt,
    idempotencyKey: `lead_form.submitted:${approvalId}`,
    metadata: {
      entity_slug: payload.entitySlug,
      form_url: payload.formUrl,
      http_status: httpStatus,
      contact_id: payload.contactId ?? null,
      ...buildOutreachMetadata(evidence),
    },
  });

  // Per-domain cooldown bookkeeping.
  await db
    .update(entityContactFormEndpoints)
    .set({ lastSubmissionAt: occurredAt, updatedAt: occurredAt })
    .where(eq(entityContactFormEndpoints.id, endpoint.id));

  // Cost ledger — zero provider cost (no third-party API). Recording
  // the entry keeps the ledger consistent across channels so
  // reply-rate / cost-per-reply comparisons against email work
  // cleanly. Idempotency key matches the email pattern.
  await costLedger.record({
    idempotencyKey: `lead_form.submit:${approvalId}:${payload.formUrl}`,
    operation: 'lead_form.submit',
    provider: 'self',
    units: 1,
    unitKind: 'submissions',
    costUsdMicros: 0,
    occurredAt,
  });

  // Stamp the approval as applied so the executor is idempotent.
  await db
    .update(approvals)
    .set({
      appliedAt: occurredAt,
      appliedObjectId: touchpointId,
    })
    .where(eq(approvals.id, approvalId));

  return { ok: true, httpStatus, touchpointId };
}
