import 'server-only';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  pursuits,
  pursuitTasks,
  users,
  type Pursuit,
} from '@procur/db';

export type PursuitStageKey =
  | 'identification'
  | 'qualification'
  | 'capture_planning'
  | 'proposal_development'
  | 'submitted'
  | 'awarded'
  | 'lost';

export const STAGE_ORDER: PursuitStageKey[] = [
  'identification',
  'qualification',
  'capture_planning',
  'proposal_development',
  'submitted',
  'awarded',
  'lost',
];

export const STAGE_LABEL: Record<PursuitStageKey, string> = {
  identification: 'Identification',
  qualification: 'Qualification',
  capture_planning: 'Capture Planning',
  proposal_development: 'Proposal Development',
  submitted: 'Submitted',
  awarded: 'Awarded',
  lost: 'Lost',
};

export const TERMINAL_STAGES: PursuitStageKey[] = ['awarded', 'lost'];

export type PursuitCard = {
  id: string;
  stage: PursuitStageKey;
  pWin: number | null;
  weightedValueUsd: number | null;
  notes: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  opportunity: {
    id: string;
    slug: string | null;
    title: string;
    type: string | null;
    valueEstimate: string | null;
    currency: string | null;
    valueEstimateUsd: string | null;
    deadlineAt: Date | null;
    jurisdictionName: string;
    jurisdictionCountry: string;
    agencyName: string | null;
    agencyShort: string | null;
    referenceNumber: string | null;
    aiSummary: string | null;
  };
  tasks: { total: number; openCount: number; overdueCount: number };
  createdAt: Date;
  updatedAt: Date;
};

type PursuitRow = Awaited<ReturnType<typeof selectPursuitsBase>>[number];

function selectPursuitsBase(companyId: string) {
  return db
    .select({
      id: pursuits.id,
      stage: pursuits.stage,
      pWin: pursuits.pWin,
      weightedValue: pursuits.weightedValue,
      notes: pursuits.notes,
      assignedUserId: pursuits.assignedUserId,
      assignedUserFirstName: users.firstName,
      assignedUserLastName: users.lastName,
      oppId: opportunities.id,
      oppSlug: opportunities.slug,
      oppTitle: opportunities.title,
      oppType: opportunities.type,
      oppValueEstimate: opportunities.valueEstimate,
      oppCurrency: opportunities.currency,
      oppValueEstimateUsd: opportunities.valueEstimateUsd,
      oppDeadlineAt: opportunities.deadlineAt,
      oppReferenceNumber: opportunities.referenceNumber,
      oppAiSummary: opportunities.aiSummary,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      agencyShort: agencies.shortName,
      createdAt: pursuits.createdAt,
      updatedAt: pursuits.updatedAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .leftJoin(users, eq(users.id, pursuits.assignedUserId))
    .where(eq(pursuits.companyId, companyId));
}

async function attachTaskCounts(
  companyId: string,
  rows: PursuitRow[],
): Promise<PursuitCard[]> {
  if (rows.length === 0) return [];
  const pursuitIds = rows.map((r) => r.id);

  const now = new Date();
  const taskCounts = await db
    .select({
      pursuitId: pursuitTasks.pursuitId,
      total: sql<number>`count(*)::int`,
      openCount: sql<number>`count(*) filter (where ${pursuitTasks.completedAt} is null)::int`,
      overdueCount: sql<number>`count(*) filter (where ${pursuitTasks.completedAt} is null and ${pursuitTasks.dueDate} < ${now.toISOString().slice(0, 10)})::int`,
    })
    .from(pursuitTasks)
    .where(inArray(pursuitTasks.pursuitId, pursuitIds))
    .groupBy(pursuitTasks.pursuitId);

  const counts = new Map(taskCounts.map((c) => [c.pursuitId, c]));

  return rows.map((r) => {
    const t = counts.get(r.id) ?? { total: 0, openCount: 0, overdueCount: 0 };
    const fullName = [r.assignedUserFirstName, r.assignedUserLastName]
      .filter(Boolean)
      .join(' ') || null;
    const pWin = r.pWin != null ? Number.parseFloat(r.pWin) : null;
    const weightedValueUsd =
      r.weightedValue != null ? Number.parseFloat(r.weightedValue) : null;

    return {
      id: r.id,
      stage: r.stage as PursuitStageKey,
      pWin,
      weightedValueUsd,
      notes: r.notes,
      assignedUserId: r.assignedUserId,
      assignedUserName: fullName,
      opportunity: {
        id: r.oppId,
        slug: r.oppSlug,
        title: r.oppTitle,
        type: r.oppType,
        valueEstimate: r.oppValueEstimate,
        currency: r.oppCurrency,
        valueEstimateUsd: r.oppValueEstimateUsd,
        deadlineAt: r.oppDeadlineAt,
        jurisdictionName: r.jurisdictionName,
        jurisdictionCountry: r.jurisdictionCountry,
        agencyName: r.agencyName,
        agencyShort: r.agencyShort,
        referenceNumber: r.oppReferenceNumber,
        aiSummary: r.oppAiSummary,
      },
      tasks: {
        total: t.total ?? 0,
        openCount: t.openCount ?? 0,
        overdueCount: t.overdueCount ?? 0,
      },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function listCompanyPursuits(companyId: string): Promise<PursuitCard[]> {
  const rows = await selectPursuitsBase(companyId).orderBy(desc(pursuits.updatedAt));
  return attachTaskCounts(companyId, rows);
}

export async function listPursuitsByStage(companyId: string) {
  const cards = await listCompanyPursuits(companyId);
  const byStage = new Map<PursuitStageKey, PursuitCard[]>();
  for (const stage of STAGE_ORDER) byStage.set(stage, []);
  for (const c of cards) byStage.get(c.stage)?.push(c);
  return byStage;
}

export async function getPursuitById(
  companyId: string,
  pursuitId: string,
): Promise<PursuitCard | null> {
  const rows = await selectPursuitsBase(companyId);
  const match = rows.find((r) => r.id === pursuitId);
  if (!match) return null;
  const [card] = await attachTaskCounts(companyId, [match]);
  return card ?? null;
}

export async function getPursuitRaw(
  companyId: string,
  pursuitId: string,
): Promise<Pursuit | null> {
  const row = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)),
  });
  return row ?? null;
}

export async function listPursuitTasks(pursuitId: string) {
  return db
    .select({
      id: pursuitTasks.id,
      title: pursuitTasks.title,
      description: pursuitTasks.description,
      dueDate: pursuitTasks.dueDate,
      completedAt: pursuitTasks.completedAt,
      priority: pursuitTasks.priority,
      category: pursuitTasks.category,
      assignedUserFirstName: users.firstName,
      assignedUserLastName: users.lastName,
    })
    .from(pursuitTasks)
    .leftJoin(users, eq(users.id, pursuitTasks.assignedUserId))
    .where(eq(pursuitTasks.pursuitId, pursuitId))
    .orderBy(asc(pursuitTasks.completedAt), asc(pursuitTasks.dueDate));
}

export async function getCompanyStageCounts(companyId: string) {
  const rows = await db
    .select({ stage: pursuits.stage, c: count() })
    .from(pursuits)
    .where(eq(pursuits.companyId, companyId))
    .groupBy(pursuits.stage);

  const map = new Map<PursuitStageKey, number>();
  for (const stage of STAGE_ORDER) map.set(stage, 0);
  for (const r of rows) map.set(r.stage as PursuitStageKey, r.c);
  return map;
}

export async function getActivePursuitCount(companyId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(pursuits)
    .where(
      and(
        eq(pursuits.companyId, companyId),
        sql`${pursuits.stage} NOT IN ('awarded', 'lost')`,
      ),
    );
  return row?.c ?? 0;
}

export type StageCountsMap = Awaited<ReturnType<typeof getCompanyStageCounts>>;

// -- Dashboard widgets -------------------------------------------------------

export type DashboardData = {
  tasks: {
    pending: number;
    inProgress: number;
    completed: number;
    dueSoon: Array<{
      id: string;
      title: string;
      dueDate: string | null;
      pursuitId: string;
      pursuitTitle: string;
    }>;
  };
  captureQuestions: {
    pursuitsWithAnyAnswer: number;
    activePursuits: number;
    /** Pursuits owned by the requesting user that have any open question. */
    myAssigned: Array<{
      pursuitId: string;
      pursuitTitle: string;
      answeredCount: number;
      totalQuestions: number;
    }>;
  };
  pipelineByValueUsd: Array<{ stage: PursuitStageKey; valueUsd: number; count: number }>;
  activeOpportunities: {
    activePursuits: number;
    dueIn30Days: number;
  };
};

const CAPTURE_QUESTION_KEYS = [
  'winThemes',
  'customerBudget',
  'customerPainPoints',
  'incumbents',
  'competitors',
  'differentiators',
  'risksAndMitigations',
  'teamPartners',
] as const;

type CaptureAnswers = Record<(typeof CAPTURE_QUESTION_KEYS)[number], unknown>;

function answeredQuestionCount(answers: unknown): number {
  if (!answers || typeof answers !== 'object') return 0;
  const a = answers as CaptureAnswers;
  let n = 0;
  for (const key of CAPTURE_QUESTION_KEYS) {
    const v = a[key];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    n += 1;
  }
  return n;
}

/**
 * Single-shot fetch backing the Capture dashboard widgets:
 *   - Tasks summary (Pending / In Progress / Completed) + due-soon list
 *   - Capture-questions completion across active pursuits
 *   - Pipeline-by-value bucketed by stage
 *   - Active-opportunity counts (active + due in 30 days)
 *
 * One pass over pursuits + tasks tables to keep the dashboard load fast
 * even on companies with hundreds of pursuits.
 */
export async function getCaptureDashboardData(
  companyId: string,
  userId: string,
): Promise<DashboardData> {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in30Iso = in30.toISOString().slice(0, 10);

  // Pursuits with capture answers + value + stage. The captureAnswers blob is
  // small and cheap to ship.
  const pursuitRows = await db
    .select({
      id: pursuits.id,
      stage: pursuits.stage,
      assignedUserId: pursuits.assignedUserId,
      captureAnswers: pursuits.captureAnswers,
      oppTitle: opportunities.title,
      valueEstimateUsd: opportunities.valueEstimateUsd,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(eq(pursuits.companyId, companyId));

  // Active = stage not in {awarded, lost}.
  const closedStages = new Set<PursuitStageKey>(['awarded', 'lost']);
  const active = pursuitRows.filter((p) => !closedStages.has(p.stage as PursuitStageKey));

  // Tasks across this company's pursuits (in one query — no per-pursuit loop).
  const pursuitIds = pursuitRows.map((p) => p.id);
  let taskRows: Array<{
    id: string;
    title: string;
    pursuitId: string;
    dueDate: string | null;
    completedAt: Date | null;
  }> = [];
  if (pursuitIds.length > 0) {
    taskRows = await db
      .select({
        id: pursuitTasks.id,
        title: pursuitTasks.title,
        pursuitId: pursuitTasks.pursuitId,
        dueDate: pursuitTasks.dueDate,
        completedAt: pursuitTasks.completedAt,
      })
      .from(pursuitTasks)
      .where(inArray(pursuitTasks.pursuitId, pursuitIds));
  }

  // Tasks: classify each
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  const titleByPursuit = new Map<string, string>();
  for (const p of pursuitRows) titleByPursuit.set(p.id, p.oppTitle);

  for (const t of taskRows) {
    if (t.completedAt) completed += 1;
    else if (t.dueDate && t.dueDate < todayIso) inProgress += 1;
    else pending += 1;
  }

  const dueSoon = taskRows
    .filter(
      (t) =>
        t.completedAt === null &&
        t.dueDate !== null &&
        t.dueDate >= todayIso &&
        t.dueDate <= in30Iso,
    )
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      pursuitId: t.pursuitId,
      pursuitTitle: titleByPursuit.get(t.pursuitId) ?? '',
    }));

  // Capture-question completion.
  const totalQuestions = CAPTURE_QUESTION_KEYS.length;
  const pursuitsWithAnyAnswer = active.filter(
    (p) => answeredQuestionCount(p.captureAnswers) > 0,
  ).length;

  const myAssigned = active
    .filter((p) => p.assignedUserId === userId)
    .map((p) => ({
      pursuitId: p.id,
      pursuitTitle: p.oppTitle,
      answeredCount: answeredQuestionCount(p.captureAnswers),
      totalQuestions,
    }))
    .sort((a, b) => a.answeredCount - b.answeredCount)
    .slice(0, 5);

  // Pipeline by value, bucketed by stage.
  const pipelineByValueUsd: Array<{ stage: PursuitStageKey; valueUsd: number; count: number }> =
    STAGE_ORDER.map((stage) => ({ stage, valueUsd: 0, count: 0 }));
  const indexByStage = new Map<PursuitStageKey, number>();
  pipelineByValueUsd.forEach((r, i) => indexByStage.set(r.stage, i));
  for (const p of pursuitRows) {
    const idx = indexByStage.get(p.stage as PursuitStageKey);
    if (idx == null) continue;
    pipelineByValueUsd[idx]!.count += 1;
    const v = p.valueEstimateUsd != null ? Number.parseFloat(p.valueEstimateUsd) : null;
    if (v != null && Number.isFinite(v)) pipelineByValueUsd[idx]!.valueUsd += v;
  }

  // Active opportunities (this is "active pursuits" — distinct from the
  // global Discover opportunity count). Due-in-30 = active pursuits whose
  // opportunity deadline falls in the next 30 days.
  const activeWithDeadline = await db
    .select({ deadlineAt: opportunities.deadlineAt })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .where(
      and(
        eq(pursuits.companyId, companyId),
        sql`${pursuits.stage} NOT IN ('awarded', 'lost')`,
      ),
    );
  const dueIn30Days = activeWithDeadline.filter(
    (r) => r.deadlineAt !== null && r.deadlineAt > now && r.deadlineAt <= in30,
  ).length;

  return {
    tasks: { pending, inProgress, completed, dueSoon },
    captureQuestions: {
      pursuitsWithAnyAnswer,
      activePursuits: active.length,
      myAssigned,
    },
    pipelineByValueUsd,
    activeOpportunities: {
      activePursuits: active.length,
      dueIn30Days,
    },
  };
}
