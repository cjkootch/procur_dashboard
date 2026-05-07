import { and, eq, gte, inArray, isNotNull, sql as drizzleSql } from 'drizzle-orm';
import {
  approvals,
  db,
  events,
  outreachFeatureSnapshots,
  users,
} from '@procur/db';
import { createId } from '../agents/id';
import type { MlEvidenceT } from '../agents/action-descriptor';

/**
 * Resolve the operator user id for gamification attribution. Single-
 * user (Phase 0 lock-in) — pulls the oldest user with a non-null
 * companyId. When multi-user lands, this should pull from
 * approvals.reviewerId for the matching approvalId. Returns null if
 * no operator exists yet (don't credit XP in that case).
 */
async function resolveOperatorUserId(): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.companyId))
    .orderBy(users.createdAt)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Lazy-loaded awardXp from @procur/catalog. The import path is built
 * via a string variable so tsc doesn't traverse the catalog module
 * graph from inside @procur/ai — that direction would create a
 * type-resolution cycle (catalog already imports from ai for
 * executor entry points). At runtime the resolver finds the package
 * just fine via the workspace.
 */
async function awardOutreachXp(args: {
  eventId: string;
  verb: string;
  occurredAt: Date;
}): Promise<void> {
  try {
    const userId = await resolveOperatorUserId();
    if (!userId) return;
    const catalogModule = '@procur/catalog';
    const mod = (await import(/* @vite-ignore */ catalogModule)) as {
      awardXp: (input: {
        userId: string;
        eventId?: string | null;
        sourceTable?: string | null;
        sourceId?: string | null;
        verb: string;
        occurredAt?: Date;
      }) => Promise<unknown>;
    };
    await mod.awardXp({
      userId,
      eventId: args.eventId,
      sourceTable: 'events',
      sourceId: args.eventId,
      verb: args.verb,
      occurredAt: args.occurredAt,
    });
  } catch (err) {
    console.error('[outreach-evidence] awardXp failed', err, {
      verb: args.verb,
    });
  }
}

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
  const eventId = createId();
  await db
    .insert(events)
    .values({
      id: eventId,
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

  await awardOutreachXp({
    eventId,
    verb: 'outreach.sent',
    occurredAt: args.occurredAt,
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

/**
 * Emit a downstream outreach lifecycle event (replied / converted /
 * disqualified). Idempotent on `(approvalId, verb)` so duplicate
 * webhook deliveries / repeated lead conversions don't double-count.
 *
 * Returns true when the event was inserted (or already existed
 * because of the dedupe key); false on insert error.
 *
 * Pulls the `outreach.sent` event for the same approvalId so the
 * outcome inherits the model_version + evidence_item_ids — that's
 * the join Match Performance Dashboard pivots on. Falls back to
 * empty metadata when no sent event exists (manual operator-driven
 * sends still produce a usable outcome row).
 */
export async function emitOutreachOutcome(args: {
  approvalId: string;
  verb: Exclude<OutreachLifecycleVerb, 'outreach.proposed' | 'outreach.approved' | 'outreach.sent'>;
  occurredAt: Date;
  /** Optional extra metadata — e.g. inbound channel, deal id, lead id. */
  metadata?: Record<string, unknown>;
  /** Object id stamped onto the event row — typically the inbound
   *  message id, lead id, or deal id that triggered the outcome. */
  objectId?: string;
  /** Object type — defaults to 'outreach'. */
  objectType?: string;
}): Promise<boolean> {
  // Hydrate from the matching outreach.sent so model_version + item
  // ids ride through. One `outreach.sent` row per (approval, channel)
  // — pick the most recent.
  const sent = await db
    .select({ metadata: events.metadata })
    .from(events)
    .where(
      and(
        eq(events.subjectId, args.approvalId),
        eq(events.verb, 'outreach.sent'),
      ),
    )
    .orderBy(events.occurredAt)
    .limit(1);
  const sentMeta = (sent[0]?.metadata as Record<string, unknown> | null) ?? {};

  try {
    const outcomeEventId = createId();
    await db
      .insert(events)
      .values({
        id: outcomeEventId,
        verb: args.verb,
        subjectType: 'approval',
        subjectId: args.approvalId,
        actorType: 'system',
        actorId: 'outreach-pipeline',
        objectType: args.objectType ?? 'outreach',
        objectId: args.objectId ?? args.approvalId,
        occurredAt: args.occurredAt,
        idempotencyKey: `${args.verb}:${args.approvalId}`,
        metadata: {
          ...(sentMeta['model_version']
            ? { model_version: sentMeta['model_version'] }
            : {}),
          ...(sentMeta['evidence_item_ids']
            ? { evidence_item_ids: sentMeta['evidence_item_ids'] }
            : {}),
          ...(sentMeta['entity_slug']
            ? { entity_slug: sentMeta['entity_slug'] }
            : {}),
          ...(sentMeta['signal_id']
            ? { signal_id: sentMeta['signal_id'] }
            : {}),
          ...(sentMeta['channel']
            ? { channel: sentMeta['channel'] }
            : {}),
          ...(args.metadata ?? {}),
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    await awardOutreachXp({
      eventId: outcomeEventId,
      verb: args.verb,
      occurredAt: args.occurredAt,
    });

    // Outcome-label stamp on the LightGBM training table. Each
    // verb maps to a boolean column on outreach_feature_snapshots;
    // we update in-place so the snapshot we wrote at proposal time
    // gets a label for the trainer. Idempotent — re-running the
    // same verb just resets the boolean to the same value. Errors
    // swallowed; a missing snapshot row (action wasn't an outreach
    // type) is also fine.
    try {
      await stampOutreachLabel({
        approvalId: args.approvalId,
        verb: args.verb,
        occurredAt: args.occurredAt,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[outreach-evidence] label stamp failed', err);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stamp the boolean column on outreach_feature_snapshots
 * corresponding to the lifecycle verb. `replied_within_14d` is
 * computed from the elapsed time between the snapshot's
 * created_at and the verb's occurredAt — anything ≤14d after
 * proposal counts. Late replies leave the column false (not null),
 * which lets the trainer treat them as negative examples.
 */
async function stampOutreachLabel(args: {
  approvalId: string;
  verb: OutreachLifecycleVerb;
  occurredAt: Date;
}): Promise<void> {
  const set: Record<string, unknown> = { labelsUpdatedAt: new Date() };

  if (args.verb === 'outreach.replied') {
    const [snap] = await db
      .select({ createdAt: outreachFeatureSnapshots.createdAt })
      .from(outreachFeatureSnapshots)
      .where(eq(outreachFeatureSnapshots.approvalId, args.approvalId))
      .limit(1);
    if (!snap) return;
    const ageMs =
      args.occurredAt.getTime() - new Date(snap.createdAt).getTime();
    set['repliedWithin14d'] = ageMs <= 14 * 24 * 3600 * 1000;
  } else if (args.verb === 'outreach.meeting_booked') {
    set['meetingBooked'] = true;
  } else if (args.verb === 'outreach.converted_to_lead') {
    set['convertedToLead'] = true;
  } else if (args.verb === 'outreach.converted_to_deal') {
    set['convertedToDeal'] = true;
  } else if (args.verb === 'outreach.disqualified') {
    set['disqualified'] = true;
  } else {
    return;
  }

  await db
    .update(outreachFeatureSnapshots)
    .set(set)
    .where(eq(outreachFeatureSnapshots.approvalId, args.approvalId));
}

/**
 * Find recent outreach approvals (with `outreach.sent` events) that
 * targeted the given contact/org/entity. Used by the lead-close +
 * contact-opt-out + deal-conversion paths to attribute downstream
 * outcomes back to the originating outreach.
 *
 * Lookback default: 30 days (longer than the inbound-reply window
 * because conversion takes longer than reply).
 *
 * Matches on the outreach.sent event's metadata fields:
 *   - entity_slug → for entity-keyed conversions
 *   - The approvals.proposed_payload.contactId / orgId would also
 *     work but requires a join; metadata is faster + already populated
 *     by the recommendation pipeline.
 */
export async function findRecentOutreachApprovalsByEntity(
  entitySlug: string,
  options: { sinceHours?: number } = {},
): Promise<string[]> {
  const since = new Date(
    Date.now() - (options.sinceHours ?? 30 * 24) * 60 * 60 * 1000,
  );
  const rows = await db
    .select({ subjectId: events.subjectId })
    .from(events)
    .where(
      and(
        eq(events.verb, 'outreach.sent'),
        // metadata->>'entity_slug' lookup
        sqlEntitySlugMatch(entitySlug),
        sqlOccurredAfter(since),
      ),
    );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!seen.has(r.subjectId)) {
      seen.add(r.subjectId);
      out.push(r.subjectId);
    }
  }
  return out;
}

function sqlEntitySlugMatch(slug: string) {
  return drizzleSql`${events.metadata}->>'entity_slug' = ${slug}`;
}
function sqlOccurredAfter(d: Date) {
  return drizzleSql`${events.occurredAt} >= ${d}`;
}

/**
 * Find recent applied communication approvals targeting any contact
 * at the given organization. Joins approvals → contacts (via
 * payload.contactId) → contacts.orgId. Used by the deal-conversion
 * path (deal targets buyerOrgId; outreach was to specific contacts
 * at that org).
 */
export async function findRecentOutreachApprovalsByOrg(
  orgId: string,
  options: { sinceHours?: number } = {},
): Promise<string[]> {
  const since = new Date(
    Date.now() - (options.sinceHours ?? 30 * 24) * 60 * 60 * 1000,
  );
  // Inline join via JSONB → contacts.id → contacts.org_id. One query
  // per org-attributed conversion is cheap; if this becomes a hot path
  // we can pre-materialize approvals.target_org_id at insert time.
  const rows = await db.execute(drizzleSql`
    SELECT a.id
      FROM approvals a
      JOIN contacts c ON c.id = (a.proposed_payload->>'contactId')
     WHERE a.action_type IN ('email.send','sms.send','whatsapp.send','whatsapp.send_template','outbound_call')
       AND a.applied_at IS NOT NULL
       AND a.applied_at >= ${since}
       AND c.org_id = ${orgId}
  `);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.rows as Array<{ id: string }>) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r.id);
    }
  }
  return out;
}

/**
 * Find recent applied communication approvals (email/sms/whatsapp/
 * call) that targeted the given contact id. Used by the disqualified +
 * converted outcome paths.
 *
 * Lookback default: 30 days. Filters to approvals.appliedAt being
 * non-null (i.e. the executor actually dispatched), so a rejected
 * approval doesn't get attributed.
 */
export async function findRecentOutreachApprovalsByContact(
  contactId: string,
  options: { sinceHours?: number } = {},
): Promise<string[]> {
  const since = new Date(
    Date.now() - (options.sinceHours ?? 30 * 24) * 60 * 60 * 1000,
  );
  const COMM_TYPES = [
    'email.send',
    'sms.send',
    'whatsapp.send',
    'whatsapp.send_template',
    'outbound_call',
  ];
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        inArray(approvals.actionType, COMM_TYPES),
        isNotNull(approvals.appliedAt),
        gte(approvals.appliedAt, since),
        drizzleSql`${approvals.proposedPayload}->>'contactId' = ${contactId}`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Find recent `outreach.sent` events for any of the supplied
 * approvalIds, returning a map of approvalId → first sent timestamp.
 * Used by inbound-webhook outcome emitters to confirm an inbound
 * actually corresponds to an outreach we sent.
 */
export async function findOutreachSentForApprovals(
  approvalIds: string[],
): Promise<Map<string, Date>> {
  if (approvalIds.length === 0) return new Map();
  const rows = await db
    .select({
      subjectId: events.subjectId,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.verb, 'outreach.sent'),
        inArray(events.subjectId, approvalIds),
      ),
    );
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (!out.has(r.subjectId)) out.set(r.subjectId, r.occurredAt);
  }
  return out;
}
