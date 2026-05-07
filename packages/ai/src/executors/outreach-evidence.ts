import { eq } from 'drizzle-orm';
import { db, events } from '@procur/db';
import { createId } from '../agents/id';
import type { MlEvidenceT } from '../agents/action-descriptor';

/**
 * Shared outreach-evidence handling for the email + Twilio executors.
 * The recommendation pipeline attaches an evidence pack to the
 * ActionDescriptor; on dispatch we (a) preserve the pack on every
 * touchpoint + audit event so post-hoc model performance can join
 * evidence ↔ outcomes, and (b) emit a single `outreach.sent` event
 * tagged with `modelVersion` and the evidence-item ids that produced
 * the recommendation.
 *
 * Manual operator-driven sends (no recommendation pipeline involved)
 * skip the outreach.sent emission — the per-channel events
 * (email.sent / sms.sent / whatsapp.sent / voice.initiated) cover
 * those for general audit.
 */

/** Subset of ActionDescriptor fields the executors need at dispatch. */
export interface OutreachEvidence {
  evidenceJson?: Record<string, unknown>;
  mlEvidence?: MlEvidenceT;
  sourceEntitySlug?: string;
  sourceSignalId?: string;
  sourceOpportunityId?: string;
  riskWarnings?: string[];
  doNotMention?: string[];
}

/** True if the descriptor carries any recommendation-pipeline output. */
export function hasOutreachEvidence(e: OutreachEvidence): boolean {
  return Boolean(
    e.mlEvidence ||
      e.evidenceJson ||
      e.sourceEntitySlug ||
      e.sourceSignalId ||
      e.sourceOpportunityId,
  );
}

/**
 * Pull the evidence fields off a JSONB `proposed_payload` into the
 * runtime shape. Tolerant of missing / mistyped fields — invalid
 * shapes return undefined for that field rather than throwing, so
 * an evidence-light approval still dispatches.
 */
export function parseOutreachEvidence(
  payload: Record<string, unknown> | null | undefined,
): OutreachEvidence {
  if (!payload || typeof payload !== 'object') return {};
  const out: OutreachEvidence = {};
  if (
    payload['evidenceJson'] &&
    typeof payload['evidenceJson'] === 'object' &&
    !Array.isArray(payload['evidenceJson'])
  ) {
    out.evidenceJson = payload['evidenceJson'] as Record<string, unknown>;
  }
  if (
    payload['mlEvidence'] &&
    typeof payload['mlEvidence'] === 'object' &&
    !Array.isArray(payload['mlEvidence']) &&
    typeof (payload['mlEvidence'] as Record<string, unknown>)['modelVersion'] ===
      'string' &&
    Array.isArray((payload['mlEvidence'] as Record<string, unknown>)['items'])
  ) {
    out.mlEvidence = payload['mlEvidence'] as MlEvidenceT;
  }
  if (typeof payload['sourceEntitySlug'] === 'string') {
    out.sourceEntitySlug = payload['sourceEntitySlug'] as string;
  }
  if (typeof payload['sourceSignalId'] === 'string') {
    out.sourceSignalId = payload['sourceSignalId'] as string;
  }
  if (typeof payload['sourceOpportunityId'] === 'string') {
    out.sourceOpportunityId = payload['sourceOpportunityId'] as string;
  }
  if (Array.isArray(payload['riskWarnings'])) {
    const arr = (payload['riskWarnings'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
    if (arr.length > 0) out.riskWarnings = arr;
  }
  if (Array.isArray(payload['doNotMention'])) {
    const arr = (payload['doNotMention'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
    if (arr.length > 0) out.doNotMention = arr;
  }
  return out;
}

/**
 * Build the metadata fragment to mix into touchpoints.metadata and
 * the per-channel audit event metadata. Returns an empty object when
 * the descriptor carries no evidence (so manual sends don't pollute
 * their metadata with `outreach_evidence: null` keys).
 */
export function buildOutreachMetadata(
  e: OutreachEvidence,
): Record<string, unknown> {
  if (!hasOutreachEvidence(e)) return {};
  return {
    outreach_source: {
      ...(e.sourceEntitySlug ? { entity_slug: e.sourceEntitySlug } : {}),
      ...(e.sourceSignalId ? { signal_id: e.sourceSignalId } : {}),
      ...(e.sourceOpportunityId
        ? { opportunity_id: e.sourceOpportunityId }
        : {}),
    },
    ...(e.mlEvidence
      ? {
          ml_evidence: {
            model_version: e.mlEvidence.modelVersion,
            total_score: e.mlEvidence.totalScore ?? null,
            item_ids: e.mlEvidence.items.map((i) => i.sourceId),
            items: e.mlEvidence.items,
          },
        }
      : {}),
    ...(e.evidenceJson ? { evidence_json: e.evidenceJson } : {}),
    ...(e.riskWarnings && e.riskWarnings.length > 0
      ? { risk_warnings: e.riskWarnings }
      : {}),
    ...(e.doNotMention && e.doNotMention.length > 0
      ? { do_not_mention: e.doNotMention }
      : {}),
  };
}

/**
 * Emit an `outreach.sent` audit event when the descriptor carries
 * recommendation-pipeline evidence. Idempotent on (approvalId,
 * channel) — re-running the executor (rare) won't double-emit.
 *
 * Emits in addition to the per-channel event (email.sent / sms.sent /
 * whatsapp.sent / voice.initiated). Powers the outreach-lifecycle
 * timeline used by ML model-performance dashboards joining sent →
 * outreach.replied → outreach.converted_to_deal.
 */
export async function emitOutreachSent(args: {
  approvalId: string;
  channel:
    | 'email'
    | 'sms'
    | 'whatsapp'
    | 'whatsapp_template'
    | 'outbound_call';
  evidence: OutreachEvidence;
  occurredAt: Date;
  /** Provider id of the dispatched message / call (Resend or Twilio
   *  message SID / call SID). Renders in the outreach timeline so
   *  model-performance views can pivot on a real message. */
  providerObjectId?: string;
}): Promise<void> {
  if (!hasOutreachEvidence(args.evidence)) return;
  const { mlEvidence } = args.evidence;
  await db
    .insert(events)
    .values({
      id: createId(),
      verb: 'outreach.sent',
      subjectType: 'approval',
      subjectId: args.approvalId,
      actorType: 'system',
      actorId: 'outreach-pipeline',
      objectType: 'outreach',
      objectId: args.providerObjectId ?? args.approvalId,
      occurredAt: args.occurredAt,
      idempotencyKey: `outreach.sent:${args.approvalId}:${args.channel}`,
      metadata: {
        channel: args.channel,
        ...(mlEvidence
          ? {
              model_version: mlEvidence.modelVersion,
              total_score: mlEvidence.totalScore ?? null,
              evidence_item_ids: mlEvidence.items.map((i) => i.sourceId),
            }
          : {}),
        ...(args.evidence.sourceEntitySlug
          ? { entity_slug: args.evidence.sourceEntitySlug }
          : {}),
        ...(args.evidence.sourceSignalId
          ? { signal_id: args.evidence.sourceSignalId }
          : {}),
        ...(args.evidence.sourceOpportunityId
          ? { opportunity_id: args.evidence.sourceOpportunityId }
          : {}),
      },
    })
    .onConflictDoNothing({
      target: [events.occurredAt, events.idempotencyKey],
    });
}

/**
 * Whitelist of valid outreach lifecycle event verbs. The recommendation
 * pipeline emits `outreach.sent`; cron / inbox webhooks / deal
 * conversions emit the rest as outcomes flow in. Joining these to
 * `events.subject_id = approval.id` is how model-performance dashboards
 * compute reply rate, conversion rate, et al.
 */
export const OUTREACH_LIFECYCLE_VERBS = [
  'outreach.proposed',
  'outreach.approved',
  'outreach.sent',
  'outreach.replied',
  'outreach.no_response_7d',
  'outreach.meeting_booked',
  'outreach.converted_to_lead',
  'outreach.converted_to_deal',
  'outreach.disqualified',
] as const;
export type OutreachLifecycleVerb = (typeof OUTREACH_LIFECYCLE_VERBS)[number];

// Silence the unused-eq lint — kept available for future joins inside
// helpers in this file (e.g. dedupe lookup before emit).
void eq;
