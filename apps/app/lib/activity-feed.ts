import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  auditLog,
  db,
  opportunities,
  pursuits,
  users,
} from '@procur/db';

/**
 * Curated subset of audit events that are interesting enough to show
 * in a company-wide activity feed. We deliberately exclude noisy
 * editorial events (`pursuit.updated`, `pursuit.capture_answers_saved`,
 * task reopens, granular requirement edits) and destructive ones
 * (`gate_review_deleted`) — the audit log itself is the system of
 * record; the feed is the storyboard.
 */
const FEED_ACTIONS = [
  'pursuit.created',
  'pursuit.stage_moved',
  'pursuit.gate_review_created',
  'pursuit.gate_review_updated',
  'pursuit.team_member_added',
  'task.completed',
] as const;

export type ActivityFeedEntry = {
  id: string;
  action: (typeof FEED_ACTIONS)[number];
  pursuitId: string | null;
  pursuitTitle: string | null;
  actorName: string | null;
  /** action-specific extras: stage labels, decision, partner name, etc. */
  metadata: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
  createdAt: Date;
};

/**
 * Fetch the most recent activity rows for a company. Joined with users
 * (actor name) and pursuits→opportunities (entity title) so the feed
 * UI doesn't have to do per-row lookups.
 */
export async function listCompanyActivity(
  companyId: string,
  limit = 12,
): Promise<ActivityFeedEntry[]> {
  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      metadata: auditLog.metadata,
      changes: auditLog.changes,
      createdAt: auditLog.createdAt,
      actorFirstName: users.firstName,
      actorLastName: users.lastName,
      actorEmail: users.email,
      pursuitId: pursuits.id,
      opportunityTitle: opportunities.title,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(
      pursuits,
      and(eq(auditLog.entityType, 'pursuit'), eq(pursuits.id, auditLog.entityId)),
    )
    .leftJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(
      and(
        eq(auditLog.companyId, companyId),
        inArray(auditLog.action, FEED_ACTIONS as unknown as string[]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    action: r.action as (typeof FEED_ACTIONS)[number],
    pursuitId: r.pursuitId ?? null,
    pursuitTitle: r.opportunityTitle ?? null,
    actorName:
      [r.actorFirstName, r.actorLastName].filter(Boolean).join(' ') ||
      r.actorEmail ||
      null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    changes: (r.changes as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt,
  }));
}

/**
 * Render-time copy for each event type. Returns a `verb` (past tense,
 * imperative voice) and an optional `detail` string. The actor name is
 * prepended by the UI; this helper produces the rest.
 *
 * For gate_review_updated we drop the row when the decision didn't
 * actually change — those are just summary tweaks and not feed-worthy.
 */
export function describeActivity(
  entry: ActivityFeedEntry,
): { verb: string; detail: string | null } | null {
  switch (entry.action) {
    case 'pursuit.created':
      return { verb: 'started a new pursuit', detail: null };
    case 'pursuit.stage_moved': {
      const before = (entry.changes as { before?: { stage?: string } } | null)?.before
        ?.stage;
      const after = (entry.changes as { after?: { stage?: string } } | null)?.after
        ?.stage;
      const detail = before && after ? `${humanStage(before)} → ${humanStage(after)}` : null;
      return { verb: 'moved a pursuit forward', detail };
    }
    case 'pursuit.gate_review_created': {
      const stage = (entry.metadata as { stage?: string } | null)?.stage;
      return { verb: 'opened a gate review', detail: stage ?? null };
    }
    case 'pursuit.gate_review_updated': {
      const before = (entry.changes as { before?: { decision?: string } } | null)?.before
        ?.decision;
      const after = (entry.changes as { after?: { decision?: string } } | null)?.after
        ?.decision;
      // Decision didn't change → not feed-worthy.
      if (!after || after === before) return null;
      if (after === 'pending') return null;
      const detail =
        (entry.metadata as { stage?: string } | null)?.stage ?? null;
      return { verb: `signed off a gate review as ${after}`, detail };
    }
    case 'pursuit.team_member_added': {
      const partner = (entry.metadata as { partnerName?: string } | null)?.partnerName;
      return {
        verb: 'added a teaming partner',
        detail: partner ?? null,
      };
    }
    case 'task.completed': {
      const title = (entry.metadata as { title?: string } | null)?.title;
      return {
        verb: 'completed a task',
        detail: title ?? null,
      };
    }
  }
}

function humanStage(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
