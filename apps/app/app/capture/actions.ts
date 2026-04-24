'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  auditLog,
  db,
  opportunities,
  pursuits,
  pursuitGateReviews,
  pursuitTasks,
  pursuitTeamMembers,
  TEAM_ROLES,
  TEAMING_STATUSES,
  type GateReviewCriterion,
  type GateReviewCriterionStatus,
  type GateReviewDecision,
  type NewPursuit,
  type NewPursuitGateReview,
  type NewPursuitTask,
  type NewPursuitTeamMember,
  type TeamingStatus,
  type TeamRole,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { STAGE_ORDER, type PursuitStageKey, getActivePursuitCount } from '../../lib/capture-queries';
import { seedCriteria } from '../../lib/gate-review-queries';

const FREE_TIER_ACTIVE_PURSUIT_CAP = 5;

async function resolveUserAndCompany() {
  const { user, company } = await requireCompany();
  return { user, company };
}

/**
 * Record a pursuit-scoped audit event. All events — even task events —
 * are keyed on the parent pursuit so the activity feed can pull the
 * whole history with one indexed query on (entity_type, entity_id).
 *
 * Write failures never fail the user-facing action; they log and move on.
 */
async function recordPursuitAudit(params: {
  companyId: string;
  userId: string;
  action: string;
  pursuitId: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      companyId: params.companyId,
      userId: params.userId,
      action: params.action,
      entityType: 'pursuit',
      entityId: params.pursuitId,
      changes: params.changes ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error('[audit_log] write failed', err);
  }
}

export async function createPursuitAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const opportunityId = String(formData.get('opportunityId') ?? '');
  const notes = formData.get('notes');
  if (!opportunityId) throw new Error('opportunityId is required');

  const opp = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, opportunityId),
    columns: { id: true, valueEstimateUsd: true },
  });
  if (!opp) throw new Error('opportunity not found');

  const existing = await db.query.pursuits.findFirst({
    where: and(
      eq(pursuits.companyId, company.id),
      eq(pursuits.opportunityId, opportunityId),
    ),
  });
  if (existing) {
    redirect(`/capture/pursuits/${existing.id}`);
  }

  if (company.planTier === 'free') {
    const active = await getActivePursuitCount(company.id);
    if (active >= FREE_TIER_ACTIVE_PURSUIT_CAP) {
      redirect('/billing?reason=pursuit-cap');
    }
  }

  const row: NewPursuit = {
    companyId: company.id,
    opportunityId,
    stage: 'identification',
    assignedUserId: user.id,
    notes: typeof notes === 'string' && notes.trim().length > 0 ? notes : null,
  };

  const [created] = await db.insert(pursuits).values(row).returning({ id: pursuits.id });
  if (!created) throw new Error('failed to create pursuit');

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.created',
    pursuitId: created.id,
    changes: { after: { opportunityId, stage: 'identification' } },
  });

  revalidatePath('/capture');
  revalidatePath('/capture/pursuits');
  revalidatePath('/capture/pipeline');
  redirect(`/capture/pursuits/${created.id}`);
}

export async function moveStageAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const stage = String(formData.get('stage') ?? '') as PursuitStageKey;

  if (!pursuitId || !STAGE_ORDER.includes(stage)) {
    throw new Error('invalid stage move');
  }

  const prior = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { stage: true },
  });
  if (!prior) throw new Error('pursuit not found');
  if (prior.stage === stage) return;

  const updates: Partial<Record<string, unknown>> = { stage, updatedAt: new Date() };
  const now = new Date();
  if (stage === 'submitted') updates.submittedAt = now;
  if (stage === 'awarded') updates.wonAt = now;
  if (stage === 'lost') updates.lostAt = now;

  await db
    .update(pursuits)
    .set(updates)
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.stage_moved',
    pursuitId,
    changes: { before: { stage: prior.stage }, after: { stage } },
  });

  revalidatePath('/capture');
  revalidatePath('/capture/pipeline');
  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function updatePursuitAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!pursuitId) throw new Error('pursuitId is required');

  const pWin = formData.get('pWin');
  const notes = formData.get('notes');
  const assignedUserId = formData.get('assignedUserId');

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const fieldsChanged: string[] = [];
  if (typeof pWin === 'string' && pWin.length > 0) {
    const n = Number.parseFloat(pWin);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      updates.pWin = String(n);
      fieldsChanged.push('pWin');
    }
  }
  if (typeof notes === 'string') {
    updates.notes = notes;
    fieldsChanged.push('notes');
  }
  if (typeof assignedUserId === 'string') {
    updates.assignedUserId = assignedUserId || null;
    fieldsChanged.push('assignedUserId');
  }

  await db
    .update(pursuits)
    .set(updates)
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)));

  if (fieldsChanged.length > 0) {
    await recordPursuitAudit({
      companyId: company.id,
      userId: user.id,
      action: 'pursuit.updated',
      pursuitId,
      metadata: { fields: fieldsChanged },
    });
  }

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function saveCaptureAnswersAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const raw = formData.get('answers');
  if (!pursuitId || typeof raw !== 'string') throw new Error('invalid input');

  let answers: Record<string, unknown>;
  try {
    answers = JSON.parse(raw);
  } catch {
    throw new Error('answers must be valid JSON');
  }

  await db
    .update(pursuits)
    .set({ captureAnswers: answers, updatedAt: new Date() })
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.capture_answers_saved',
    pursuitId,
    metadata: { answeredKeys: Object.keys(answers).filter((k) => hasValue(answers[k])) },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

export async function addTaskAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const dueDate = formData.get('dueDate');
  const category = formData.get('category');
  const priority = formData.get('priority');

  if (!pursuitId || !title) throw new Error('title required');

  const owner = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true },
  });
  if (!owner) throw new Error('pursuit not found or not owned by your company');

  const row: NewPursuitTask = {
    pursuitId,
    title,
    assignedUserId: user.id,
    dueDate: typeof dueDate === 'string' && dueDate.length > 0 ? dueDate : null,
    category: typeof category === 'string' && category.length > 0 ? category : null,
    priority: typeof priority === 'string' && priority.length > 0 ? priority : 'medium',
  };

  const [created] = await db.insert(pursuitTasks).values(row).returning({ id: pursuitTasks.id });

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'task.created',
    pursuitId,
    metadata: {
      taskId: created?.id,
      title,
      dueDate: row.dueDate,
      priority: row.priority,
      category: row.category,
    },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
  revalidatePath('/capture/tasks');
}

export async function toggleTaskAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const taskId = String(formData.get('taskId') ?? '');
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!taskId) throw new Error('taskId required');

  // Ensure the task belongs to a pursuit this company owns.
  const row = await db
    .select({
      id: pursuitTasks.id,
      title: pursuitTasks.title,
      completedAt: pursuitTasks.completedAt,
      pursuitId: pursuitTasks.pursuitId,
      companyId: pursuits.companyId,
    })
    .from(pursuitTasks)
    .innerJoin(pursuits, eq(pursuits.id, pursuitTasks.pursuitId))
    .where(eq(pursuitTasks.id, taskId))
    .limit(1);

  const task = row[0];
  if (!task || task.companyId !== company.id) throw new Error('task not found');

  const wasCompleted = task.completedAt !== null;
  await db
    .update(pursuitTasks)
    .set({
      completedAt: wasCompleted ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pursuitTasks.id, taskId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: wasCompleted ? 'task.reopened' : 'task.completed',
    pursuitId: task.pursuitId,
    metadata: { taskId, title: task.title },
  });

  if (pursuitId) revalidatePath(`/capture/pursuits/${pursuitId}`);
  revalidatePath('/capture/tasks');
}

// ===========================================================================
// Gate reviews
// ===========================================================================

const DECISIONS: GateReviewDecision[] = ['pending', 'pass', 'conditional', 'fail'];
const CRITERION_STATUSES: GateReviewCriterionStatus[] = [
  'not_assessed',
  'met',
  'partially_met',
  'not_met',
  'na',
];

function toDecision(v: FormDataEntryValue | null): GateReviewDecision {
  const s = v == null ? '' : String(v);
  return (DECISIONS as string[]).includes(s) ? (s as GateReviewDecision) : 'pending';
}

function toCriterionStatus(v: FormDataEntryValue | null): GateReviewCriterionStatus {
  const s = v == null ? '' : String(v);
  return (CRITERION_STATUSES as string[]).includes(s)
    ? (s as GateReviewCriterionStatus)
    : 'not_assessed';
}

async function requirePursuitOwnedByCompany(
  companyId: string,
  pursuitId: string,
): Promise<void> {
  const row = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)),
    columns: { id: true },
  });
  if (!row) throw new Error('pursuit not found');
}

/**
 * Ownership-checked fetch for a gate review. Throws if not found OR if
 * the parent pursuit isn't owned by the given company.
 */
async function requireGateReview(companyId: string, gateReviewId: string) {
  const rows = await db
    .select({ review: pursuitGateReviews, companyId: pursuits.companyId })
    .from(pursuitGateReviews)
    .innerJoin(pursuits, eq(pursuits.id, pursuitGateReviews.pursuitId))
    .where(eq(pursuitGateReviews.id, gateReviewId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('gate review not found');
  return first.review;
}

export async function createGateReviewAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const stage = String(formData.get('stage') ?? '').trim();
  if (!pursuitId || !stage) throw new Error('pursuitId + stage required');
  if (stage.length > 64) throw new Error('stage too long');

  await requirePursuitOwnedByCompany(company.id, pursuitId);

  const row: NewPursuitGateReview = {
    pursuitId,
    stage,
    decision: 'pending',
    reviewerUserId: user.id,
    criteria: seedCriteria(stage),
  };
  const [created] = await db
    .insert(pursuitGateReviews)
    .values(row)
    .returning({ id: pursuitGateReviews.id });

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.gate_review_created',
    pursuitId,
    metadata: { gateReviewId: created?.id, stage },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function updateGateReviewAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const gateReviewId = String(formData.get('gateReviewId') ?? '');
  if (!gateReviewId) throw new Error('gateReviewId required');

  const existing = await requireGateReview(company.id, gateReviewId);

  const decision = formData.has('decision') ? toDecision(formData.get('decision')) : existing.decision;
  const summary = formData.has('summary')
    ? String(formData.get('summary') ?? '').trim() || null
    : existing.summary;
  const completed = decision !== 'pending';

  await db
    .update(pursuitGateReviews)
    .set({
      decision,
      summary,
      // Decision transition to non-pending stamps completedAt; going back
      // to pending clears it so the review is "in progress" again.
      completedAt: completed ? (existing.completedAt ?? new Date()) : null,
      updatedAt: new Date(),
    })
    .where(eq(pursuitGateReviews.id, gateReviewId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.gate_review_updated',
    pursuitId: existing.pursuitId,
    changes: { before: { decision: existing.decision }, after: { decision } },
    metadata: { gateReviewId, stage: existing.stage },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

/**
 * Toggle a single criterion's status + comment on a gate review.
 * Doesn't change the review's overall decision — that stays on the
 * updateGateReviewAction flow so the reviewer explicitly signs off.
 */
export async function toggleGateCriterionAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const gateReviewId = String(formData.get('gateReviewId') ?? '');
  const criterionId = String(formData.get('criterionId') ?? '');
  if (!gateReviewId || !criterionId) throw new Error('gateReviewId + criterionId required');

  const existing = await requireGateReview(company.id, gateReviewId);
  const status = toCriterionStatus(formData.get('status'));
  const comment = formData.has('comment')
    ? String(formData.get('comment') ?? '').trim() || undefined
    : undefined;

  const next: GateReviewCriterion[] = (existing.criteria ?? []).map((c) =>
    c.id === criterionId
      ? {
          ...c,
          status,
          ...(comment !== undefined ? { comment } : {}),
        }
      : c,
  );

  await db
    .update(pursuitGateReviews)
    .set({ criteria: next, updatedAt: new Date() })
    .where(eq(pursuitGateReviews.id, gateReviewId));

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

export async function deleteGateReviewAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const gateReviewId = String(formData.get('gateReviewId') ?? '');
  if (!gateReviewId) throw new Error('gateReviewId required');

  const existing = await requireGateReview(company.id, gateReviewId);

  await db.delete(pursuitGateReviews).where(eq(pursuitGateReviews.id, gateReviewId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.gate_review_deleted',
    pursuitId: existing.pursuitId,
    metadata: { gateReviewId, stage: existing.stage },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

// ===========================================================================
// Teaming
// ===========================================================================

function toRole(v: FormDataEntryValue | null): TeamRole {
  const s = v == null ? '' : String(v);
  return (TEAM_ROLES as string[]).includes(s) ? (s as TeamRole) : 'subcontractor';
}

function toStatus(v: FormDataEntryValue | null): TeamingStatus {
  const s = v == null ? '' : String(v);
  return (TEAMING_STATUSES as string[]).includes(s) ? (s as TeamingStatus) : 'engaging';
}

function toAllocation(v: FormDataEntryValue | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length === 0) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n.toFixed(2);
}

async function requireTeamMember(companyId: string, memberId: string) {
  const rows = await db
    .select({ member: pursuitTeamMembers, companyId: pursuits.companyId })
    .from(pursuitTeamMembers)
    .innerJoin(pursuits, eq(pursuits.id, pursuitTeamMembers.pursuitId))
    .where(eq(pursuitTeamMembers.id, memberId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('team member not found');
  return first.member;
}

export async function addTeamMemberAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const partnerName = String(formData.get('partnerName') ?? '').trim();
  if (!pursuitId || !partnerName) throw new Error('pursuitId + partnerName required');
  if (partnerName.length > 200) throw new Error('partnerName too long');

  await requirePursuitOwnedByCompany(company.id, pursuitId);

  const role = toRole(formData.get('role'));
  const status = toStatus(formData.get('status'));
  const allocationPct = toAllocation(formData.get('allocationPct'));
  const capabilities = String(formData.get('capabilities') ?? '').trim() || null;
  const contactName = String(formData.get('contactName') ?? '').trim() || null;
  const contactEmail = String(formData.get('contactEmail') ?? '').trim() || null;
  const notes = String(formData.get('notes') ?? '').trim() || null;

  const row: NewPursuitTeamMember = {
    pursuitId,
    partnerName,
    role,
    status,
    allocationPct,
    capabilities,
    contactName,
    contactEmail,
    notes,
  };

  const [created] = await db
    .insert(pursuitTeamMembers)
    .values(row)
    .returning({ id: pursuitTeamMembers.id });

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.team_member_added',
    pursuitId,
    metadata: { teamMemberId: created?.id, partnerName, role },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function updateTeamMemberAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const memberId = String(formData.get('teamMemberId') ?? '');
  if (!memberId) throw new Error('teamMemberId required');

  const existing = await requireTeamMember(company.id, memberId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('partnerName')) {
    const v = String(formData.get('partnerName') ?? '').trim();
    if (v.length > 0) updates.partnerName = v;
  }
  if (formData.has('role')) updates.role = toRole(formData.get('role'));
  if (formData.has('status')) updates.status = toStatus(formData.get('status'));
  if (formData.has('allocationPct')) updates.allocationPct = toAllocation(formData.get('allocationPct'));
  if (formData.has('capabilities'))
    updates.capabilities = String(formData.get('capabilities') ?? '').trim() || null;
  if (formData.has('contactName'))
    updates.contactName = String(formData.get('contactName') ?? '').trim() || null;
  if (formData.has('contactEmail'))
    updates.contactEmail = String(formData.get('contactEmail') ?? '').trim() || null;
  if (formData.has('notes'))
    updates.notes = String(formData.get('notes') ?? '').trim() || null;

  await db
    .update(pursuitTeamMembers)
    .set(updates)
    .where(eq(pursuitTeamMembers.id, memberId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.team_member_updated',
    pursuitId: existing.pursuitId,
    metadata: { teamMemberId: memberId, fields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

export async function removeTeamMemberAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const memberId = String(formData.get('teamMemberId') ?? '');
  if (!memberId) throw new Error('teamMemberId required');

  const existing = await requireTeamMember(company.id, memberId);

  await db.delete(pursuitTeamMembers).where(eq(pursuitTeamMembers.id, memberId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.team_member_removed',
    pursuitId: existing.pursuitId,
    metadata: { teamMemberId: memberId, partnerName: existing.partnerName },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

