'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  db,
  opportunities,
  pursuits,
  pursuitTasks,
  type NewPursuit,
  type NewPursuitTask,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { STAGE_ORDER, type PursuitStageKey } from '../../lib/capture-queries';

async function resolveUserAndCompany() {
  const { user, company } = await requireCompany();
  return { user, company };
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

  const row: NewPursuit = {
    companyId: company.id,
    opportunityId,
    stage: 'identification',
    assignedUserId: user.id,
    notes: typeof notes === 'string' && notes.trim().length > 0 ? notes : null,
  };

  const [created] = await db.insert(pursuits).values(row).returning({ id: pursuits.id });
  if (!created) throw new Error('failed to create pursuit');

  revalidatePath('/capture');
  revalidatePath('/capture/pursuits');
  revalidatePath('/capture/pipeline');
  redirect(`/capture/pursuits/${created.id}`);
}

export async function moveStageAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const stage = String(formData.get('stage') ?? '') as PursuitStageKey;

  if (!pursuitId || !STAGE_ORDER.includes(stage)) {
    throw new Error('invalid stage move');
  }

  const updates: Partial<Record<string, unknown>> = { stage, updatedAt: new Date() };
  const now = new Date();
  if (stage === 'submitted') updates.submittedAt = now;
  if (stage === 'awarded') updates.wonAt = now;
  if (stage === 'lost') updates.lostAt = now;

  await db
    .update(pursuits)
    .set(updates)
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)));

  revalidatePath('/capture');
  revalidatePath('/capture/pipeline');
  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function updatePursuitAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!pursuitId) throw new Error('pursuitId is required');

  const pWin = formData.get('pWin');
  const notes = formData.get('notes');
  const assignedUserId = formData.get('assignedUserId');

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof pWin === 'string' && pWin.length > 0) {
    const n = Number.parseFloat(pWin);
    if (Number.isFinite(n) && n >= 0 && n <= 1) updates.pWin = String(n);
  }
  if (typeof notes === 'string') updates.notes = notes;
  if (typeof assignedUserId === 'string') {
    updates.assignedUserId = assignedUserId || null;
  }

  await db
    .update(pursuits)
    .set(updates)
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)));

  revalidatePath(`/capture/pursuits/${pursuitId}`);
}

export async function saveCaptureAnswersAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
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

  revalidatePath(`/capture/pursuits/${pursuitId}`);
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

  await db.insert(pursuitTasks).values(row);

  revalidatePath(`/capture/pursuits/${pursuitId}`);
  revalidatePath('/capture/tasks');
}

export async function toggleTaskAction(formData: FormData): Promise<void> {
  const { company } = await resolveUserAndCompany();
  const taskId = String(formData.get('taskId') ?? '');
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!taskId) throw new Error('taskId required');

  // Ensure the task belongs to a pursuit this company owns
  const row = await db
    .select({
      id: pursuitTasks.id,
      completedAt: pursuitTasks.completedAt,
      companyId: pursuits.companyId,
    })
    .from(pursuitTasks)
    .innerJoin(pursuits, eq(pursuits.id, pursuitTasks.pursuitId))
    .where(eq(pursuitTasks.id, taskId))
    .limit(1);

  const task = row[0];
  if (!task || task.companyId !== company.id) throw new Error('task not found');

  await db
    .update(pursuitTasks)
    .set({
      completedAt: task.completedAt ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pursuitTasks.id, taskId));

  if (pursuitId) revalidatePath(`/capture/pursuits/${pursuitId}`);
  revalidatePath('/capture/tasks');
}

