import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  marketPlaybooks,
  marketProbeLearningReports,
  marketProbes,
  type LearningReportPayload,
  type MarketPlaybook,
  type MarketProbeLearningReport,
  type NewMarketPlaybook,
  type NewMarketProbeLearningReport,
} from '@procur/db';
import { createId } from '@procur/ai';

/**
 * Phase 2F catalog helpers. Two surfaces:
 *
 *   - market_playbooks lifecycle: create, list, fork (saveFromProbe),
 *     versioning, status promotion.
 *   - market_probe_learning_reports: store / list / read.
 *
 * The agent that GENERATES the learning report lives in @procur/ai;
 * these helpers just persist and read.
 */

// ──────────────────────────────────────────────────────────────────
// Playbooks
// ──────────────────────────────────────────────────────────────────

export async function createPlaybook(input: {
  name: string;
  description?: string | null;
  applicableCountries?: string[];
  recommendedSegments?: string[];
  avoidedSegments?: string[];
  bestContactTitles?: string[];
  avoidedContactTitles?: string[];
  baseHypotheses?: NewMarketPlaybook['baseHypothesesJson'];
  bestFirstTouchAngle?: string | null;
  commonObjections?: NewMarketPlaybook['commonObjectionsJson'];
  usefulDataSources?: string[];
  complianceNotes?: string | null;
  followUpCadence?: Record<string, unknown>;
  conversionBenchmarks?: Record<string, number>;
  sourceProbeIds?: string[];
  parentPlaybookId?: string | null;
  version?: number;
  status?: 'draft' | 'active' | 'deprecated';
  createdByUserId?: string | null;
}): Promise<MarketPlaybook> {
  const row: NewMarketPlaybook = {
    id: createId(),
    name: input.name,
    description: input.description ?? null,
    applicableCountries: input.applicableCountries ?? [],
    recommendedSegments: input.recommendedSegments ?? [],
    avoidedSegments: input.avoidedSegments ?? [],
    bestContactTitles: input.bestContactTitles ?? [],
    avoidedContactTitles: input.avoidedContactTitles ?? [],
    baseHypothesesJson: input.baseHypotheses ?? [],
    bestFirstTouchAngle: input.bestFirstTouchAngle ?? null,
    commonObjectionsJson: input.commonObjections ?? [],
    usefulDataSources: input.usefulDataSources ?? [],
    complianceNotes: input.complianceNotes ?? null,
    followUpCadenceJson: input.followUpCadence ?? {},
    conversionBenchmarksJson: input.conversionBenchmarks ?? {},
    sourceProbeIds: input.sourceProbeIds ?? [],
    parentPlaybookId: input.parentPlaybookId ?? null,
    version: input.version ?? 1,
    status: input.status ?? 'draft',
    createdByUserId: input.createdByUserId ?? null,
  };
  const [created] = await db.insert(marketPlaybooks).values(row).returning();
  if (!created) throw new Error('createPlaybook: no row returned');
  return created;
}

export async function listPlaybooks(options: {
  status?: 'draft' | 'active' | 'deprecated';
  country?: string;
  limit?: number;
} = {}): Promise<MarketPlaybook[]> {
  const limit = options.limit ?? 100;
  // Collect all predicates and apply ONCE via and(...). Drizzle's
  // $dynamic().where(a).where(b) REPLACES instead of AND'ing, so the
  // earlier shape (one .where per condition) silently dropped the
  // status filter when both options were set — caller filtering for
  // "active playbooks in BB" got back ALL countries' active playbooks
  // OR all-statuses BB depending on call order.
  const predicates = [];
  if (options.status) {
    predicates.push(eq(marketPlaybooks.status, options.status));
  }
  if (options.country) {
    const c = options.country.toUpperCase();
    predicates.push(
      sql`${marketPlaybooks.applicableCountries} && ARRAY[${c}]::text[]`,
    );
  }
  const baseQuery = db.select().from(marketPlaybooks).$dynamic();
  const filtered =
    predicates.length > 0 ? baseQuery.where(and(...predicates)) : baseQuery;
  return await filtered
    .orderBy(desc(marketPlaybooks.updatedAt))
    .limit(limit);
}

export async function getPlaybook(
  id: string,
): Promise<MarketPlaybook | null> {
  const [row] = await db
    .select()
    .from(marketPlaybooks)
    .where(eq(marketPlaybooks.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Save a probe as a new playbook (or new version of an existing
 * playbook). Pulls the probe's segments + outreach angle + atlas
 * negative rules + scorecard benchmarks + recent learning report
 * (if one exists) to seed the playbook.
 *
 * If `parentPlaybookId` is supplied, this becomes v(parent.version+1)
 * and the parent flips to 'deprecated'. Otherwise this is v1.
 */
export async function savePlaybookFromProbe(input: {
  probeId: string;
  name: string;
  description?: string | null;
  parentPlaybookId?: string | null;
  applicableCountries?: string[];
  benchmarks: Record<string, number>;
  // Optional overrides — operator can edit the report's nominations
  // before saving.
  recommendedSegments?: string[];
  avoidedSegments?: string[];
  bestContactTitles?: string[];
  avoidedContactTitles?: string[];
  bestFirstTouchAngle?: string | null;
  baseHypotheses?: Array<{
    hypothesisType: string;
    statement: string;
    confidenceStart: number;
    testMethod?: string;
  }>;
  createdByUserId?: string | null;
}): Promise<MarketPlaybook> {
  let version = 1;
  let parent: MarketPlaybook | null = null;
  if (input.parentPlaybookId) {
    parent = await getPlaybook(input.parentPlaybookId);
    if (parent) version = parent.version + 1;
  }
  const created = await createPlaybook({
    name: input.name,
    description: input.description ?? null,
    applicableCountries: input.applicableCountries ?? [],
    recommendedSegments: input.recommendedSegments ?? [],
    avoidedSegments: input.avoidedSegments ?? [],
    bestContactTitles: input.bestContactTitles ?? [],
    avoidedContactTitles: input.avoidedContactTitles ?? [],
    baseHypotheses: input.baseHypotheses ?? [],
    bestFirstTouchAngle: input.bestFirstTouchAngle ?? null,
    conversionBenchmarks: input.benchmarks,
    sourceProbeIds: [input.probeId],
    parentPlaybookId: input.parentPlaybookId ?? null,
    version,
    status: 'draft',
    createdByUserId: input.createdByUserId ?? null,
  });
  // Demote parent — only one 'active' version per fork chain at a
  // time. Operator promotes the new draft to active when ready.
  if (parent && parent.status === 'active') {
    await db
      .update(marketPlaybooks)
      .set({ status: 'deprecated', updatedAt: new Date() })
      .where(eq(marketPlaybooks.id, parent.id));
  }
  return created;
}

export async function setPlaybookStatus(
  id: string,
  status: 'draft' | 'active' | 'deprecated',
): Promise<void> {
  await db
    .update(marketPlaybooks)
    .set({ status, updatedAt: new Date() })
    .where(eq(marketPlaybooks.id, id));
}

// ──────────────────────────────────────────────────────────────────
// Learning reports
// ──────────────────────────────────────────────────────────────────

export async function insertLearningReport(input: {
  probeId: string;
  summary: string;
  payload: LearningReportPayload;
  scorecardSnapshot: Record<string, unknown>;
  generatedByModel?: string | null;
}): Promise<MarketProbeLearningReport> {
  const row: NewMarketProbeLearningReport = {
    id: createId(),
    probeId: input.probeId,
    summary: input.summary,
    payloadJson: input.payload,
    scorecardSnapshotJson: input.scorecardSnapshot,
    generatedByModel: input.generatedByModel ?? null,
  };
  const [created] = await db
    .insert(marketProbeLearningReports)
    .values(row)
    .returning();
  if (!created) throw new Error('insertLearningReport: no row returned');
  return created;
}

export async function listLearningReports(
  probeId: string,
): Promise<MarketProbeLearningReport[]> {
  return await db
    .select()
    .from(marketProbeLearningReports)
    .where(eq(marketProbeLearningReports.probeId, probeId))
    .orderBy(desc(marketProbeLearningReports.generatedAt));
}

export async function getLatestLearningReport(
  probeId: string,
): Promise<MarketProbeLearningReport | null> {
  const [row] = await db
    .select()
    .from(marketProbeLearningReports)
    .where(eq(marketProbeLearningReports.probeId, probeId))
    .orderBy(desc(marketProbeLearningReports.generatedAt))
    .limit(1);
  return row ?? null;
}

// Re-export the structural type so apps/app reads via @procur/catalog.
export type { LearningReportPayload };
