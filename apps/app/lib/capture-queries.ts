import 'server-only';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
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
    valueEstimate: string | null;
    currency: string | null;
    valueEstimateUsd: string | null;
    deadlineAt: Date | null;
    jurisdictionName: string;
    jurisdictionCountry: string;
    agencyName: string | null;
    agencyShort: string | null;
    referenceNumber: string | null;
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
      oppValueEstimate: opportunities.valueEstimate,
      oppCurrency: opportunities.currency,
      oppValueEstimateUsd: opportunities.valueEstimateUsd,
      oppDeadlineAt: opportunities.deadlineAt,
      oppReferenceNumber: opportunities.referenceNumber,
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
    .where(sql`${pursuitTasks.pursuitId} = ANY(${pursuitIds})`)
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
        valueEstimate: r.oppValueEstimate,
        currency: r.oppCurrency,
        valueEstimateUsd: r.oppValueEstimateUsd,
        deadlineAt: r.oppDeadlineAt,
        jurisdictionName: r.jurisdictionName,
        jurisdictionCountry: r.jurisdictionCountry,
        agencyName: r.agencyName,
        agencyShort: r.agencyShort,
        referenceNumber: r.oppReferenceNumber,
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
