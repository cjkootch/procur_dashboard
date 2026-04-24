'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  auditLog,
  db,
  opportunities,
  pursuits,
  pursuitTasks,
  type NewPursuit,
  type NewPursuitTask,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { STAGE_ORDER, type PursuitStageKey, getActivePursuitCount } from '../../lib/capture-queries';

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

