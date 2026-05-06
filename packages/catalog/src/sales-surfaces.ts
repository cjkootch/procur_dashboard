import 'server-only';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  campaignSteps,
  campaigns,
  db,
  followUps,
} from '@procur/db';

/**
 * Read helpers for /campaigns and /follow-ups (vex-into-procur merge
 * Phase 4). Pairs with the Phase 1 schema tables.
 */

export interface CampaignListRow {
  id: string;
  channel: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
  source: string | null;
  medium: string | null;
  objective: string | null;
  spend: number | null;
  stepCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listCampaigns(
  options: { limit?: number } = {},
): Promise<CampaignListRow[]> {
  const limit = options.limit ?? 100;
  const rows = await db
    .select({
      id: campaigns.id,
      channel: campaigns.channel,
      status: campaigns.status,
      source: campaigns.source,
      medium: campaigns.medium,
      objective: campaigns.objective,
      spend: campaigns.spend,
      createdAt: campaigns.createdAt,
      updatedAt: campaigns.updatedAt,
      stepCount: sql<number>`(SELECT count(*)::int FROM ${campaignSteps} WHERE ${campaignSteps.campaignId} = ${campaigns.id})`,
    })
    .from(campaigns)
    .orderBy(desc(campaigns.updatedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    status: r.status,
    source: r.source,
    medium: r.medium,
    objective: r.objective,
    spend: r.spend,
    stepCount: Number(r.stepCount ?? 0),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export interface CampaignDetail {
  campaign: {
    id: string;
    channel: string;
    status: 'active' | 'paused' | 'completed' | 'archived';
    source: string | null;
    medium: string | null;
    objective: string | null;
    spend: number | null;
    createdAt: Date;
    updatedAt: Date;
  };
  steps: Array<{
    id: string;
    position: number;
    channel: string;
    delayAfterPriorMs: number;
    templateRef: string | null;
    subjectOverride: string | null;
    bodyOverride: string | null;
    tier: string;
    autoApprove: boolean;
  }>;
}

export async function getCampaignDetail(
  id: string,
): Promise<CampaignDetail | null> {
  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const steps = await db
    .select({
      id: campaignSteps.id,
      position: campaignSteps.position,
      channel: campaignSteps.channel,
      delayAfterPriorMs: campaignSteps.delayAfterPriorMs,
      templateRef: campaignSteps.templateRef,
      subjectOverride: campaignSteps.subjectOverride,
      bodyOverride: campaignSteps.bodyOverride,
      tier: campaignSteps.tier,
      autoApprove: campaignSteps.autoApprove,
    })
    .from(campaignSteps)
    .where(eq(campaignSteps.campaignId, id))
    .orderBy(asc(campaignSteps.position));
  return {
    campaign: {
      id: row.id,
      channel: row.channel,
      status: row.status,
      source: row.source,
      medium: row.medium,
      objective: row.objective,
      spend: row.spend,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    steps: steps.map((s) => ({
      id: s.id,
      position: s.position,
      channel: s.channel,
      delayAfterPriorMs: s.delayAfterPriorMs,
      templateRef: s.templateRef,
      subjectOverride: s.subjectOverride,
      bodyOverride: s.bodyOverride,
      tier: s.tier,
      autoApprove: s.autoApprove,
    })),
  };
}

export interface FollowUpListRow {
  id: string;
  title: string;
  note: string | null;
  dueAt: Date;
  status: 'open' | 'completed' | 'cancelled';
  subjectType: string | null;
  subjectId: string | null;
  assignedTo: string | null;
  completedAt: Date | null;
}

export async function listFollowUps(
  options: { status?: 'open' | 'completed' | 'cancelled'; limit?: number } = {},
): Promise<FollowUpListRow[]> {
  const limit = options.limit ?? 100;
  const rows = await db
    .select({
      id: followUps.id,
      title: followUps.title,
      note: followUps.note,
      dueAt: followUps.dueAt,
      status: followUps.status,
      subjectType: followUps.subjectType,
      subjectId: followUps.subjectId,
      assignedTo: followUps.assignedTo,
      completedAt: followUps.completedAt,
    })
    .from(followUps)
    .where(options.status ? eq(followUps.status, options.status) : undefined)
    .orderBy(asc(followUps.dueAt))
    .limit(limit);
  return rows as FollowUpListRow[];
}

/**
 * Mark a follow-up complete. Idempotent — re-completing a completed
 * row is a no-op (we filter by status='open' in the WHERE).
 */
export async function completeFollowUp(
  id: string,
): Promise<{ updated: boolean }> {
  const updated = await db
    .update(followUps)
    .set({ status: 'completed', completedAt: new Date() })
    .where(and(eq(followUps.id, id), eq(followUps.status, 'open')))
    .returning({ id: followUps.id });
  return { updated: updated.length > 0 };
}

/**
 * Insert a follow-up row. Used by the follow_up.schedule executor +
 * any direct surfaces that need to schedule a reminder.
 */
export async function insertFollowUp(input: {
  title: string;
  note?: string | null;
  dueAt: Date;
  subjectType?: string | null;
  subjectId?: string | null;
  assignedTo?: string | null;
  createdBy: string;
}): Promise<{ id: string }> {
  const { createId } = await import('@procur/ai');
  const id = createId();
  await db.insert(followUps).values({
    id,
    title: input.title,
    note: input.note ?? null,
    dueAt: input.dueAt,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    assignedTo: input.assignedTo ?? null,
    createdBy: input.createdBy,
    status: 'open',
  });
  return { id };
}

void isNull; // re-export-friendly imports for future filter additions
