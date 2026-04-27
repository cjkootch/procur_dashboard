'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  auditLog,
  CAPABILITY_CATEGORIES,
  COVERAGE_STATUSES,
  companyCapabilities,
  db,
  opportunities,
  pursuits,
  pursuitCapabilityRequirements,
  pursuitGateReviews,
  pursuitTasks,
  pursuitTeamMembers,
  REQUIREMENT_PRIORITIES,
  TEAM_ROLES,
  TEAMING_STATUSES,
  type CapabilityCategory,
  type CoverageStatus,
  type GateReviewCriterion,
  type GateReviewCriterionStatus,
  type GateReviewDecision,
  type NewCompanyCapability,
  type NewPursuit,
  type NewPursuitCapabilityRequirement,
  type NewPursuitGateReview,
  type NewPursuitTask,
  type NewPursuitTeamMember,
  type RequirementPriority,
  type TeamingStatus,
  type TeamRole,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { meter, MODELS, suggestRequirements } from '@procur/ai';
import { STAGE_ORDER, STAGE_LABEL, type PursuitStageKey, getActivePursuitCount } from '../../lib/capture-queries';
import { seedCriteria } from '../../lib/gate-review-queries';
import { insertNotification } from '../../lib/notification-queries';
import { FREE_TIER_ACTIVE_PURSUIT_CAP } from '../../lib/plan-limits';
import { fireExtractRequirements } from '../../lib/trigger-extract-requirements';

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

  // Defer expensive Sonnet requirement-extraction until tracking time.
  // Idempotent — re-runs across users / tenants are no-ops.
  await fireExtractRequirements(opportunityId);

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
    columns: { stage: true, assignedUserId: true },
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

  // Notify the assignee (if anyone is assigned and they didn't make the
  // move themselves). Self-moves don't need a self-notification.
  if (prior.assignedUserId && prior.assignedUserId !== user.id) {
    await insertNotification({
      userId: prior.assignedUserId,
      companyId: company.id,
      type: 'pursuit.stage_moved',
      title: `Pursuit moved to ${STAGE_LABEL[stage]}`,
      body: `From ${STAGE_LABEL[prior.stage as PursuitStageKey] ?? prior.stage}.`,
      link: `/capture/pursuits/${pursuitId}`,
      entityType: 'pursuit',
      entityId: pursuitId,
    });
  }

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

/**
 * Bulk-complete every task whose id is in the submitted form. Each
 * task is verified to belong to the caller's company before any write
 * happens, so a tampered formData with foreign task IDs can't escape
 * tenant isolation.
 *
 * Audit fans out: one `task.completed` row per task. Skipping
 * already-completed tasks keeps re-submits idempotent.
 */
export async function bulkCompleteTasksAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const ids = formData.getAll('taskId').map((v) => String(v)).filter(Boolean);
  if (ids.length === 0) return;

  const owned = await db
    .select({
      id: pursuitTasks.id,
      title: pursuitTasks.title,
      completedAt: pursuitTasks.completedAt,
      pursuitId: pursuitTasks.pursuitId,
      companyId: pursuits.companyId,
    })
    .from(pursuitTasks)
    .innerJoin(pursuits, eq(pursuits.id, pursuitTasks.pursuitId))
    .where(inArray(pursuitTasks.id, ids))
    .then((r) => r.filter((t) => t.companyId === company.id && !t.completedAt));

  if (owned.length === 0) return;

  const now = new Date();
  await db
    .update(pursuitTasks)
    .set({ completedAt: now, updatedAt: now })
    .where(inArray(pursuitTasks.id, owned.map((t) => t.id)));

  // Fan out audit rows so the activity feed for each pursuit reflects
  // the completion. Failures here don't roll back the update — same
  // policy as the single-task action.
  await Promise.all(
    owned.map((t) =>
      recordPursuitAudit({
        companyId: company.id,
        userId: user.id,
        action: 'task.completed',
        pursuitId: t.pursuitId,
        metadata: { taskId: t.id, title: t.title, source: 'bulk' },
      }),
    ),
  );

  revalidatePath('/capture/tasks');
  for (const t of owned) {
    revalidatePath(`/capture/pursuits/${t.pursuitId}`);
  }
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

  // Notify the pursuit assignee on a meaningful decision transition
  // (pending → pass/conditional/fail). Not every save — only when the
  // decision actually changes — so reviewers tweaking their own
  // summary don't spam the inbox.
  if (decision !== existing.decision && decision !== 'pending') {
    const owner = await db.query.pursuits.findFirst({
      where: eq(pursuits.id, existing.pursuitId),
      columns: { assignedUserId: true },
    });
    if (owner?.assignedUserId && owner.assignedUserId !== user.id) {
      await insertNotification({
        userId: owner.assignedUserId,
        companyId: company.id,
        type: 'pursuit.gate_review_decided',
        title: `Gate review: ${decision === 'pass' ? 'passed' : decision === 'fail' ? 'failed' : decision}`,
        body: `Stage: ${existing.stage}. ${summary ? summary.slice(0, 140) : ''}`,
        link: `/capture/pursuits/${existing.pursuitId}?tab=gate-reviews`,
        entityType: 'gate_review',
        entityId: gateReviewId,
      });
    }
  }

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

// ===========================================================================
// Capabilities (company bank + per-pursuit requirements matrix)
// ===========================================================================

function toCategory(v: FormDataEntryValue | null): CapabilityCategory {
  const s = v == null ? '' : String(v);
  return (CAPABILITY_CATEGORIES as string[]).includes(s)
    ? (s as CapabilityCategory)
    : 'service';
}

function toPriority(v: FormDataEntryValue | null): RequirementPriority {
  const s = v == null ? '' : String(v);
  return (REQUIREMENT_PRIORITIES as string[]).includes(s)
    ? (s as RequirementPriority)
    : 'must';
}

function toCoverage(v: FormDataEntryValue | null): CoverageStatus {
  const s = v == null ? '' : String(v);
  return (COVERAGE_STATUSES as string[]).includes(s)
    ? (s as CoverageStatus)
    : 'not_assessed';
}

async function requireCapability(companyId: string, capabilityId: string) {
  const row = await db.query.companyCapabilities.findFirst({
    where: and(
      eq(companyCapabilities.id, capabilityId),
      eq(companyCapabilities.companyId, companyId),
    ),
  });
  if (!row) throw new Error('capability not found');
  return row;
}

async function requireRequirement(companyId: string, requirementId: string) {
  const rows = await db
    .select({ req: pursuitCapabilityRequirements, companyId: pursuits.companyId })
    .from(pursuitCapabilityRequirements)
    .innerJoin(pursuits, eq(pursuits.id, pursuitCapabilityRequirements.pursuitId))
    .where(eq(pursuitCapabilityRequirements.id, requirementId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('requirement not found');
  return first.req;
}

export async function addCapabilityAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const name = String(formData.get('name') ?? '').trim();
  const pursuitId = String(formData.get('pursuitId') ?? '') || null;
  if (!name) throw new Error('name required');
  if (name.length > 200) throw new Error('name too long');

  const row: NewCompanyCapability = {
    companyId: company.id,
    name,
    category: toCategory(formData.get('category')),
    description: String(formData.get('description') ?? '').trim() || null,
    evidenceUrl: String(formData.get('evidenceUrl') ?? '').trim() || null,
  };

  const [created] = await db
    .insert(companyCapabilities)
    .values(row)
    .returning({ id: companyCapabilities.id });

  if (pursuitId) {
    revalidatePath(`/capture/pursuits/${pursuitId}`);
    // No audit on the pursuit — capability bank is company-scoped, not
    // pursuit-scoped. We only log when it gets mapped to a requirement.
  }

  // Suppress unused-var lint for user/created on the no-pursuit path.
  void user;
  void created;
}

export async function updateCapabilityAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const capabilityId = String(formData.get('capabilityId') ?? '');
  if (!capabilityId) throw new Error('capabilityId required');

  await requireCapability(company.id, capabilityId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('name')) {
    const v = String(formData.get('name') ?? '').trim();
    if (v.length > 0) updates.name = v;
  }
  if (formData.has('category')) updates.category = toCategory(formData.get('category'));
  if (formData.has('description'))
    updates.description = String(formData.get('description') ?? '').trim() || null;
  if (formData.has('evidenceUrl'))
    updates.evidenceUrl = String(formData.get('evidenceUrl') ?? '').trim() || null;

  await db
    .update(companyCapabilities)
    .set(updates)
    .where(eq(companyCapabilities.id, capabilityId));

  const pursuitId = String(formData.get('pursuitId') ?? '') || null;
  if (pursuitId) revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function removeCapabilityAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const capabilityId = String(formData.get('capabilityId') ?? '');
  if (!capabilityId) throw new Error('capabilityId required');

  await requireCapability(company.id, capabilityId);

  // Requirements that reference this capability will have capability_id
  // set to null automatically (FK on delete: set null), turning them
  // back into unmapped gaps.
  await db.delete(companyCapabilities).where(eq(companyCapabilities.id, capabilityId));

  const pursuitId = String(formData.get('pursuitId') ?? '') || null;
  if (pursuitId) revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function addRequirementAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const requirement = String(formData.get('requirement') ?? '').trim();
  if (!pursuitId || !requirement) throw new Error('pursuitId + requirement required');
  if (requirement.length > 1000) throw new Error('requirement too long');

  await requirePursuitOwnedByCompany(company.id, pursuitId);

  const capRaw = String(formData.get('capabilityId') ?? '').trim();
  const capabilityId = capRaw.length > 0 ? capRaw : null;
  if (capabilityId) {
    // Verify the capability belongs to this company before linking.
    await requireCapability(company.id, capabilityId);
  }

  const row: NewPursuitCapabilityRequirement = {
    pursuitId,
    requirement,
    priority: toPriority(formData.get('priority')),
    coverage: toCoverage(formData.get('coverage')),
    capabilityId,
    notes: String(formData.get('notes') ?? '').trim() || null,
  };

  const [created] = await db
    .insert(pursuitCapabilityRequirements)
    .values(row)
    .returning({ id: pursuitCapabilityRequirements.id });

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.requirement_added',
    pursuitId,
    metadata: {
      requirementId: created?.id,
      priority: row.priority,
      coverage: row.coverage,
      hasCapability: capabilityId !== null,
    },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function updateRequirementAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const requirementId = String(formData.get('requirementId') ?? '');
  if (!requirementId) throw new Error('requirementId required');

  const existing = await requireRequirement(company.id, requirementId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('requirement')) {
    const v = String(formData.get('requirement') ?? '').trim();
    if (v.length > 0) updates.requirement = v;
  }
  if (formData.has('priority')) updates.priority = toPriority(formData.get('priority'));
  if (formData.has('coverage')) updates.coverage = toCoverage(formData.get('coverage'));
  if (formData.has('capabilityId')) {
    const v = String(formData.get('capabilityId') ?? '').trim();
    if (v.length === 0) {
      updates.capabilityId = null;
    } else {
      await requireCapability(company.id, v);
      updates.capabilityId = v;
    }
  }
  if (formData.has('notes'))
    updates.notes = String(formData.get('notes') ?? '').trim() || null;

  await db
    .update(pursuitCapabilityRequirements)
    .set(updates)
    .where(eq(pursuitCapabilityRequirements.id, requirementId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.requirement_updated',
    pursuitId: existing.pursuitId,
    metadata: { requirementId, fields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

export async function removeRequirementAction(formData: FormData): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const requirementId = String(formData.get('requirementId') ?? '');
  if (!requirementId) throw new Error('requirementId required');

  const existing = await requireRequirement(company.id, requirementId);

  await db
    .delete(pursuitCapabilityRequirements)
    .where(eq(pursuitCapabilityRequirements.id, requirementId));

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.requirement_removed',
    pursuitId: existing.pursuitId,
    metadata: { requirementId },
  });

  revalidatePath(`/capture/pursuits/${existing.pursuitId}`);
}

/**
 * AI: read the pursuit's opportunity title + description, propose
 * capability-matrix requirements mapped to the company's existing
 * capability bank. Inserts each suggestion as a new requirement row,
 * skipping exact-text duplicates so re-runs are idempotent.
 *
 * Caps: 4000 chars on requirement text (matches the manual flow), 50
 * suggestions per call (above this we'd flood the matrix; users
 * should refine manually after the first pass).
 */
export async function suggestRequirementsForPursuitAction(
  formData: FormData,
): Promise<void> {
  const { user, company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!pursuitId) throw new Error('pursuitId required');

  await requirePursuitOwnedByCompany(company.id, pursuitId);

  // Load the pursuit's opportunity (title + description).
  const [opp] = await db
    .select({
      title: opportunities.title,
      description: opportunities.description,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)))
    .limit(1);
  if (!opp) throw new Error('opportunity not found');

  // Load the capability bank for the company so AI can map suggestions.
  const bank = await db
    .select({
      id: companyCapabilities.id,
      name: companyCapabilities.name,
      category: companyCapabilities.category,
      description: companyCapabilities.description,
    })
    .from(companyCapabilities)
    .where(eq(companyCapabilities.companyId, company.id));

  const validBankIds = new Set(bank.map((b) => b.id));

  let result;
  try {
    result = await suggestRequirements({
      opportunityTitle: opp.title,
      opportunityDescription: opp.description,
      capabilities: bank.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category ?? 'service',
        description: b.description,
      })),
    });
  } catch (err) {
    console.error('[suggest_requirements] AI call failed', err);
    throw new Error(
      'Could not generate requirement suggestions. Try again or add requirements manually.',
    );
  }

  await meter({
    companyId: company.id,
    source: 'suggest_requirements',
    model: MODELS.sonnet,
    usage: result.usage,
  });

  if (result.requirements.length === 0) {
    revalidatePath(`/capture/pursuits/${pursuitId}`);
    return;
  }

  // Idempotency: skip suggestions whose text already exists on this
  // pursuit so re-running doesn't create duplicates.
  const existing = await db
    .select({ requirement: pursuitCapabilityRequirements.requirement })
    .from(pursuitCapabilityRequirements)
    .where(eq(pursuitCapabilityRequirements.pursuitId, pursuitId));
  const existingSet = new Set(
    existing.map((r) => r.requirement.trim().toLowerCase()),
  );

  const rowsToInsert = result.requirements
    .filter((r) => !existingSet.has(r.requirement.trim().toLowerCase()))
    .slice(0, 50)
    .map((r) => ({
      pursuitId,
      requirement: r.requirement.slice(0, 4000),
      priority: r.priority,
      coverage: r.coverage,
      capabilityId:
        r.suggestedCapabilityId && validBankIds.has(r.suggestedCapabilityId)
          ? r.suggestedCapabilityId
          : null,
      notes: r.rationale ?? null,
    }));

  if (rowsToInsert.length === 0) {
    revalidatePath(`/capture/pursuits/${pursuitId}`);
    return;
  }

  await db.insert(pursuitCapabilityRequirements).values(rowsToInsert);

  await recordPursuitAudit({
    companyId: company.id,
    userId: user.id,
    action: 'pursuit.requirements_ai_suggested',
    pursuitId,
    metadata: {
      proposed: result.requirements.length,
      inserted: rowsToInsert.length,
      bankSize: bank.length,
      confidence: result.confidence,
    },
  });

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

