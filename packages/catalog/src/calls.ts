import 'server-only';
import { desc, sql } from 'drizzle-orm';
import { db, touchpoints } from '@procur/db';

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
