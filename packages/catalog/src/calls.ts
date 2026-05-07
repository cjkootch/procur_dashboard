import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  approvals,
  contacts,
  db,
  events,
  organizations,
  touchpoints,
} from '@procur/db';

/**
 * Calls + messaging timeline (vex-into-procur merge Phase 7). Reuses
 * the touchpoints table; rows with `channel LIKE 'voice.%'` are call
 * lifecycle entries (initiated/completed/failed/etc.); 'sms.*' and
 * 'whatsapp.*' are messaging entries.
 *
 * Phase 7 v1 doesn't add a dedicated `calls` table — touchpoints +
 * events give us enough for an MVP timeline. If Cole later wants
 * richer per-call state (current participant list, transcript, etc.)
 * a follow-up adds the table.
 */

export interface CallTimelineRow {
  id: string;
  channel: string;
  occurredAt: Date;
  contactId: string | null;
  orgId: string | null;
  metadata: Record<string, unknown>;
}

export async function listVoiceTimeline(
  options: { limit?: number } = {},
): Promise<CallTimelineRow[]> {
  const limit = options.limit ?? 100;
  const rows = await db
    .select({
      id: touchpoints.id,
      channel: touchpoints.channel,
      occurredAt: touchpoints.occurredAt,
      contactId: touchpoints.contactId,
      orgId: touchpoints.orgId,
      metadata: touchpoints.metadata,
    })
    .from(touchpoints)
    .where(sql`${touchpoints.channel} LIKE 'voice.%'`)
    .orderBy(desc(touchpoints.occurredAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    occurredAt: r.occurredAt,
    contactId: r.contactId,
    orgId: r.orgId,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

export async function listMessagingTimeline(
  options: { limit?: number } = {},
): Promise<CallTimelineRow[]> {
  const limit = options.limit ?? 100;
  const rows = await db
    .select({
      id: touchpoints.id,
      channel: touchpoints.channel,
      occurredAt: touchpoints.occurredAt,
      contactId: touchpoints.contactId,
      orgId: touchpoints.orgId,
      metadata: touchpoints.metadata,
    })
    .from(touchpoints)
    .where(
      sql`${touchpoints.channel} LIKE 'sms.%' OR ${touchpoints.channel} LIKE 'whatsapp.%'`,
    )
    .orderBy(desc(touchpoints.occurredAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    occurredAt: r.occurredAt,
    contactId: r.contactId,
    orgId: r.orgId,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Detail view for a single call. Identified by Twilio's CallSid (the
 * natural key — survives DB rebuilds, matches Twilio Console, shared
 * by every status/recording callback). Resolves the originating
 * approval (and its proposed_payload — toNumber, aiMode, goalHint,
 * aiInstructions, contact) plus the full lifecycle timeline merged
 * from touchpoints + events.
 */
export interface CallTimelineEvent {
  kind: 'touchpoint' | 'event';
  /** Channel for touchpoints (voice.initiated, voice.completed, …) or
   *  verb for events (voice.ringing, voice.recorded, …). */
  type: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface CallDetail {
  callSid: string;
  approvalId: string | null;
  /** Pulled from the originating approval's proposed_payload. */
  toNumber: string | null;
  aiMode: boolean;
  goalHint: string | null;
  aiInstructions: string | null;
  rationale: string | null;
  /** Conference room name (for the operator-join /voice UI to dial
   *  into when mode=conference). Null for AI-mode calls. */
  conferenceRoom: string | null;
  contact: { id: string; fullName: string | null } | null;
  org: { id: string; legalName: string } | null;
  /** Latest CallStatus from Twilio status callbacks (initiated /
   *  ringing / answered / completed / failed / busy / no-answer). */
  status: string | null;
  durationSeconds: number | null;
  /** All recording URLs collected from voice.recorded events. */
  recordings: { sid: string; url: string; durationSeconds: number | null }[];
  /** Merged timeline ordered ascending. */
  timeline: CallTimelineEvent[];
}

function metadataString(
  m: Record<string, unknown>,
  key: string,
): string | null {
  const v = m[key];
  return typeof v === 'string' ? v : null;
}

function metadataNumber(
  m: Record<string, unknown>,
  key: string,
): number | null {
  const v = m[key];
  return typeof v === 'number' ? v : null;
}

export async function getCallDetail(
  callSid: string,
): Promise<CallDetail | null> {
  // Lifecycle events from Twilio status + recording callbacks. These
  // share `subjectId = callSid`. Filter to voice.* verbs so a stray
  // event from another subjectType doesn't bleed in.
  const eventRows = await db
    .select({
      verb: events.verb,
      occurredAt: events.occurredAt,
      metadata: events.metadata,
    })
    .from(events)
    .where(
      and(eq(events.subjectId, callSid), sql`${events.verb} LIKE 'voice.%'`),
    )
    .orderBy(asc(events.occurredAt));

  // Touchpoints: the initial voice.initiated row from the executor
  // (actor='approval:<id>') + any terminal-status touchpoints written
  // by the status webhook (actor='twilio'). Both reference the
  // CallSid in metadata.provider_call_id.
  const touchpointRows = await db
    .select({
      channel: touchpoints.channel,
      actor: touchpoints.actor,
      occurredAt: touchpoints.occurredAt,
      contactId: touchpoints.contactId,
      orgId: touchpoints.orgId,
      metadata: touchpoints.metadata,
    })
    .from(touchpoints)
    .where(
      and(
        sql`${touchpoints.channel} LIKE 'voice.%'`,
        sql`${touchpoints.metadata}->>'provider_call_id' = ${callSid}`,
      ),
    )
    .orderBy(asc(touchpoints.occurredAt));

  if (eventRows.length === 0 && touchpointRows.length === 0) return null;

  // Pull the originating approval (if we can find it) for context.
  // The voice.initiated touchpoint's actor is `approval:<id>`; everything
  // else lives on that approval's proposed_payload.
  let approvalId: string | null = null;
  for (const t of touchpointRows) {
    if (t.actor && t.actor.startsWith('approval:')) {
      approvalId = t.actor.slice('approval:'.length);
      break;
    }
  }

  let toNumber: string | null = null;
  let aiMode = false;
  let goalHint: string | null = null;
  let aiInstructions: string | null = null;
  let rationale: string | null = null;
  let contactIdFromApproval: string | null = null;
  let orgIdFromApproval: string | null = null;
  if (approvalId) {
    const approvalRows = await db
      .select({ payload: approvals.proposedPayload })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);
    const payload =
      (approvalRows[0]?.payload as Record<string, unknown> | undefined) ?? {};
    toNumber =
      typeof payload['toNumber'] === 'string'
        ? (payload['toNumber'] as string)
        : null;
    aiMode = payload['aiMode'] === true;
    goalHint =
      typeof payload['goalHint'] === 'string'
        ? (payload['goalHint'] as string)
        : null;
    aiInstructions =
      typeof payload['aiInstructions'] === 'string'
        ? (payload['aiInstructions'] as string)
        : null;
    rationale =
      typeof payload['rationale'] === 'string'
        ? (payload['rationale'] as string)
        : null;
    contactIdFromApproval =
      typeof payload['contactId'] === 'string'
        ? (payload['contactId'] as string)
        : null;
    orgIdFromApproval =
      typeof payload['orgId'] === 'string'
        ? (payload['orgId'] as string)
        : null;
  }

  // Resolve contact + org for display. Prefer the approval payload's
  // ids (canonical) over whatever wound up on the touchpoint.
  const resolvedContactId =
    contactIdFromApproval ?? touchpointRows.find((t) => t.contactId)?.contactId ?? null;
  const resolvedOrgId =
    orgIdFromApproval ?? touchpointRows.find((t) => t.orgId)?.orgId ?? null;

  let contact: CallDetail['contact'] = null;
  if (resolvedContactId) {
    const contactRows = await db
      .select({ id: contacts.id, fullName: contacts.fullName })
      .from(contacts)
      .where(eq(contacts.id, resolvedContactId))
      .limit(1);
    contact = contactRows[0]
      ? { id: contactRows[0].id, fullName: contactRows[0].fullName ?? null }
      : null;
  }
  let org: CallDetail['org'] = null;
  if (resolvedOrgId) {
    const orgRows = await db
      .select({ id: organizations.id, legalName: organizations.legalName })
      .from(organizations)
      .where(eq(organizations.id, resolvedOrgId))
      .limit(1);
    org = orgRows[0]
      ? { id: orgRows[0].id, legalName: orgRows[0].legalName }
      : null;
  }

  // Latest non-recording status verb wins (Twilio sends these in
  // chronological order; the events query is sorted ascending so the
  // last match is the freshest).
  let status: string | null = null;
  let durationSeconds: number | null = null;
  const recordings: CallDetail['recordings'] = [];
  for (const ev of eventRows) {
    const meta = (ev.metadata as Record<string, unknown>) ?? {};
    if (ev.verb === 'voice.recorded') {
      const recordingUrl = metadataString(meta, 'recording_url');
      if (recordingUrl) {
        recordings.push({
          sid:
            metadataString(meta, 'recording_sid') ??
            `${callSid}:${ev.occurredAt.toISOString()}`,
          url: recordingUrl,
          durationSeconds: metadataNumber(meta, 'duration_seconds'),
        });
      }
      continue;
    }
    status = ev.verb.replace(/^voice\./, '');
    const dur = metadataNumber(meta, 'duration_seconds');
    if (dur != null) durationSeconds = dur;
  }

  // Merge timeline. Touchpoints + events get a unified shape ordered
  // ascending so the UI can render a single column.
  const timeline: CallTimelineEvent[] = [
    ...touchpointRows.map((t) => ({
      kind: 'touchpoint' as const,
      type: t.channel,
      occurredAt: t.occurredAt,
      metadata: (t.metadata ?? {}) as Record<string, unknown>,
    })),
    ...eventRows.map((ev) => ({
      kind: 'event' as const,
      type: ev.verb,
      occurredAt: ev.occurredAt,
      metadata: (ev.metadata ?? {}) as Record<string, unknown>,
    })),
  ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  return {
    callSid,
    approvalId,
    toNumber,
    aiMode,
    goalHint,
    aiInstructions,
    rationale,
    conferenceRoom: aiMode || !approvalId ? null : `procur-${approvalId}`,
    contact,
    org,
    status,
    durationSeconds,
    recordings,
    timeline,
  };
}
