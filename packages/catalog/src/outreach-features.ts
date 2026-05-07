import 'server-only';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import {
  approvals,
  contacts,
  db,
  entityWebFacts,
  fuelConsumptionSignals,
  organizations,
  outreachFeatureSnapshots,
  touchpoints,
  type NewOutreachFeatureSnapshot,
} from '@procur/db';

/**
 * Feature snapshot builder for the LightGBM reply-within-14-days
 * classifier. See migration 0089 + the brief for context.
 *
 * Discipline:
 *   - Captures features AT PROPOSAL TIME so the model trains on the
 *     same signals the operator saw when approving. Stamping
 *     post-approval would leak future state into the input.
 *   - Heuristics remain the fallback path until label volume is
 *     sufficient (~500 labels). This module just records signal;
 *     it doesn't make decisions.
 *   - Failure to compute features must NEVER block the approval
 *     write. All errors are swallowed + logged.
 *
 * Feature schema is documented inline below. Bump `feature_version`
 * (in the schema constants) when the shape changes — the trained
 * model uses it as a guardrail at inference time.
 */

export const FEATURE_VERSION = 'v1';

/**
 * Flat numeric/categorical feature map. LightGBM consumes this
 * directly as `feature: value` pairs. Categorical values stay as
 * strings; LightGBM handles them natively (one of the reasons we
 * picked it over XGBoost — see the brief).
 *
 * Add new features by appending here AND bumping FEATURE_VERSION.
 */
export interface OutreachFeatures {
  // ── Action descriptor ────────────────────────────────────
  /** 'email.send' | 'sms.send' | 'whatsapp.send' | 'whatsapp.send_template' | 'outbound_call'. */
  action_type: string;
  /** Body length in chars (0 for outbound_call). */
  body_length: number;
  /** Whether a templateName was set on the proposal. */
  has_template: boolean;

  // ── Org / counterparty ───────────────────────────────────
  org_country: string | null;
  org_industry: string | null;
  /** OFAC status from the organizations row. */
  org_ofac_status: string;

  // ── Web intelligence ─────────────────────────────────────
  /** Total entity_web_facts rows for the org's known_entity slug. */
  web_fact_count: number;

  // ── Fuel consumption signals ─────────────────────────────
  /** Highest-confidence fuel signal value bbl/yr midpoint, or 0. */
  max_fuel_signal_bbl_yr: number;
  /** Sum of confidence weights across all fuel signals (proxy for
   *  evidence breadth). */
  fuel_signal_confidence_sum: number;

  // ── Apollo / contact availability ────────────────────────
  /** Whether an Apollo cache row exists for the org. */
  apollo_cached: boolean;
  /** Phone present on the contact (when contactId on the action). */
  contact_has_phone: boolean;
  contact_has_email: boolean;

  // ── Touchpoint history ───────────────────────────────────
  /** All-time touchpoints to this contact. */
  touchpoints_all_time: number;
  /** Touchpoints in the last 30 days. Higher → re-contact risk. */
  touchpoints_last_30d: number;
  /** Hours since the most-recent touch on this contact. -1 if never
   *  contacted before. Capped at 365 days = 8760 hours. */
  hours_since_last_touch: number;

  // ── ML evidence pack ─────────────────────────────────────
  /** Number of evidence items the recommendation pipeline attached. */
  ml_evidence_count: number;
  /** Total recommendation score (0-100), or 0 when no ML pipeline. */
  ml_total_score: number;

  // ── Risk gates ───────────────────────────────────────────
  /** Number of riskWarnings on the proposal. */
  risk_warning_count: number;

  // ── Match-queue origin (when applicable) ─────────────────
  source_signal_kind: string | null;
}

/**
 * Build the feature map for an approval payload. Pulls from many
 * tables in parallel; never throws — returns a safe default vector
 * if any source fails.
 */
export async function buildOutreachFeatures(input: {
  approvalId: string;
  proposedPayload: Record<string, unknown>;
}): Promise<OutreachFeatures> {
  const payload = input.proposedPayload;
  const actionType = stringOf(payload['kind']);
  const body = stringOf(payload['body']);
  const orgId = stringOf(payload['orgId']);
  const contactId = stringOf(payload['contactId']);
  const knownEntitySlug = stringOf(payload['knownEntitySlug']);
  const templateName = stringOf(payload['templateName']);
  const mlEvidence = (payload['mlEvidence'] ?? null) as
    | { items?: unknown[]; totalScore?: number }
    | null;
  const riskWarnings =
    (payload['riskWarnings'] as unknown[] | undefined) ?? [];
  const sourceSignalKind = stringOf(payload['sourceSignalKind']);

  // Defaults — every path must produce these so the model has a
  // consistent vector even when sources are missing.
  const features: OutreachFeatures = {
    action_type: actionType,
    body_length: body.length,
    has_template: templateName.length > 0,
    org_country: null,
    org_industry: null,
    org_ofac_status: 'unscreened',
    web_fact_count: 0,
    max_fuel_signal_bbl_yr: 0,
    fuel_signal_confidence_sum: 0,
    apollo_cached: false,
    contact_has_phone: false,
    contact_has_email: false,
    touchpoints_all_time: 0,
    touchpoints_last_30d: 0,
    hours_since_last_touch: -1,
    ml_evidence_count: Array.isArray(mlEvidence?.items)
      ? mlEvidence.items.length
      : 0,
    ml_total_score:
      typeof mlEvidence?.totalScore === 'number' ? mlEvidence.totalScore : 0,
    risk_warning_count: riskWarnings.length,
    source_signal_kind: sourceSignalKind || null,
  };

  // Fan out the lookups in parallel; each one is independently safe.
  await Promise.all([
    safeRun(async () => {
      if (!orgId) return;
      const [row] = await db
        .select({
          country: organizations.geo,
          industry: organizations.industry,
          ofacStatus: organizations.ofacStatus,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!row) return;
      const country =
        row.country && typeof row.country === 'object' && 'country' in row.country
          ? String((row.country as Record<string, unknown>).country ?? '')
          : '';
      features.org_country = country || null;
      features.org_industry = row.industry ?? null;
      features.org_ofac_status = row.ofacStatus ?? 'unscreened';
    }),
    safeRun(async () => {
      const slug = knownEntitySlug || (await resolveSlugFromOrgId(orgId));
      if (!slug) return;
      const [row] = await db
        .select({ n: count() })
        .from(entityWebFacts)
        .where(eq(entityWebFacts.entitySlug, slug));
      features.web_fact_count = Number(row?.n ?? 0);
    }),
    safeRun(async () => {
      const slug = knownEntitySlug || (await resolveSlugFromOrgId(orgId));
      if (!slug) return;
      const rows = await db
        .select({
          min: fuelConsumptionSignals.volumeBblYrMin,
          max: fuelConsumptionSignals.volumeBblYrMax,
          confidence: fuelConsumptionSignals.confidence,
        })
        .from(fuelConsumptionSignals)
        .where(eq(fuelConsumptionSignals.entitySlug, slug));
      let maxMid = 0;
      let confSum = 0;
      for (const r of rows) {
        const mid = (Number(r.min ?? 0) + Number(r.max ?? 0)) / 2;
        if (mid > maxMid) maxMid = mid;
        confSum += Number(r.confidence ?? 0);
      }
      features.max_fuel_signal_bbl_yr = maxMid;
      features.fuel_signal_confidence_sum = confSum;
    }),
    safeRun(async () => {
      if (!contactId) return;
      const [row] = await db
        .select({ phones: contacts.phones, emails: contacts.emails })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (!row) return;
      const phones = (row.phones as string[] | null) ?? [];
      const emails = (row.emails as string[] | null) ?? [];
      features.contact_has_phone = phones.length > 0;
      features.contact_has_email = emails.length > 0;
    }),
    safeRun(async () => {
      if (!contactId) return;
      const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const [allRow] = await db
        .select({ n: count() })
        .from(touchpoints)
        .where(eq(touchpoints.contactId, contactId));
      const [recentRow] = await db
        .select({ n: count() })
        .from(touchpoints)
        .where(
          and(
            eq(touchpoints.contactId, contactId),
            gte(touchpoints.occurredAt, since30),
          ),
        );
      const [lastRow] = await db
        .select({ when: sql<Date>`MAX(${touchpoints.occurredAt})` })
        .from(touchpoints)
        .where(eq(touchpoints.contactId, contactId));
      features.touchpoints_all_time = Number(allRow?.n ?? 0);
      features.touchpoints_last_30d = Number(recentRow?.n ?? 0);
      const lastWhen = lastRow?.when ? new Date(lastRow.when) : null;
      if (lastWhen) {
        const hours = Math.min(
          (Date.now() - lastWhen.getTime()) / (3600 * 1000),
          8760,
        );
        features.hours_since_last_touch = Math.max(0, Math.round(hours));
      }
    }),
  ]);

  return features;
}

/**
 * Persist the snapshot. Idempotent on approval_id — re-running with
 * the same approval is a no-op, which lets callers be defensive
 * about double-fires from the chat path.
 */
export async function recordOutreachFeatureSnapshot(input: {
  approvalId: string;
  features: OutreachFeatures;
  featureVersion?: string;
}): Promise<void> {
  try {
    const row: NewOutreachFeatureSnapshot = {
      approvalId: input.approvalId,
      features: input.features as unknown as Record<string, unknown>,
      featureVersion: input.featureVersion ?? FEATURE_VERSION,
    };
    await db
      .insert(outreachFeatureSnapshots)
      .values(row)
      .onConflictDoNothing();
  } catch (err) {
    console.error('[outreach-features] snapshot insert failed', err);
  }
}

/**
 * Stamp an outcome label onto an existing snapshot. Called from the
 * outreach-lifecycle event emitter when replied / converted /
 * disqualified verbs fire post-approval.
 *
 * `replied_within_14d` is computed by the caller — they know the
 * timing window. This helper just writes the boolean.
 */
export async function stampOutreachOutcome(input: {
  approvalId: string;
  repliedWithin14d?: boolean;
  meetingBooked?: boolean;
  convertedToLead?: boolean;
  convertedToDeal?: boolean;
  disqualified?: boolean;
}): Promise<void> {
  try {
    const set: Record<string, unknown> = { labelsUpdatedAt: new Date() };
    if (input.repliedWithin14d !== undefined) set.repliedWithin14d = input.repliedWithin14d;
    if (input.meetingBooked !== undefined) set.meetingBooked = input.meetingBooked;
    if (input.convertedToLead !== undefined) set.convertedToLead = input.convertedToLead;
    if (input.convertedToDeal !== undefined) set.convertedToDeal = input.convertedToDeal;
    if (input.disqualified !== undefined) set.disqualified = input.disqualified;
    await db
      .update(outreachFeatureSnapshots)
      .set(set)
      .where(eq(outreachFeatureSnapshots.approvalId, input.approvalId));
  } catch (err) {
    console.error('[outreach-features] outcome stamp failed', err);
  }
}

async function resolveSlugFromOrgId(orgId: string): Promise<string | null> {
  if (!orgId) return null;
  try {
    const [row] = await db
      .select({ keys: organizations.externalKeys })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!row) return null;
    const keys = (row.keys ?? {}) as Record<string, string>;
    return keys['known_entity_slug'] ?? null;
  } catch {
    return null;
  }
}

function stringOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function safeRun(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error('[outreach-features] sub-task failed', err);
  }
}

// Re-export approvals here (only used to silence the unused-import
// warning if down-stream callers want to import the type alongside
// these helpers). Drizzle's tree-shake handles the rest.
export type { OutreachFeatureSnapshot } from '@procur/db';
void approvals;
