import 'server-only';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  contracts,
  db,
  jurisdictions,
  opportunities,
  pastPerformance,
  pursuits,
} from '@procur/db';
import { STAGE_ORDER, STAGE_LABEL, type PursuitStageKey } from './capture-queries';

export type StageBreakdown = {
  stage: PursuitStageKey;
  label: string;
  count: number;
  totalValueUsd: number;
  weightedValueUsd: number;
};

export type InsightsSnapshot = {
  totalPursuits: number;
  activePursuits: number;
  awardedCount: number;
  lostCount: number;
  winRate: number;
  pipelineValueUsd: number;
  weightedPipelineUsd: number;
  wonValueUsd: number;
  stageBreakdown: StageBreakdown[];
  topJurisdictions: Array<{ name: string; countryCode: string; pursuitCount: number; wonCount: number }>;
  topCategories: Array<{ category: string; pursuitCount: number; wonCount: number }>;
  contractCount: number;
  activeContractValueUsd: number;
  pastPerformanceCount: number;
};

export async function getInsights(companyId: string): Promise<InsightsSnapshot> {
  const pursuitRows = await db
    .select({
      id: pursuits.id,
      stage: pursuits.stage,
      pWin: pursuits.pWin,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      awardedAmount: opportunities.awardedAmount,
      category: opportunities.category,
      jurisdictionId: opportunities.jurisdictionId,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .where(eq(pursuits.companyId, companyId));

  const byStage = new Map<PursuitStageKey, StageBreakdown>();
  for (const s of STAGE_ORDER) {
    byStage.set(s, {
      stage: s,
      label: STAGE_LABEL[s],
      count: 0,
      totalValueUsd: 0,
      weightedValueUsd: 0,
    });
  }

  const jurisdictionAgg = new Map<
    string,
    { name: string; countryCode: string; pursuitCount: number; wonCount: number }
  >();
  const categoryAgg = new Map<string, { pursuitCount: number; wonCount: number }>();

  let pipelineValueUsd = 0;
  let weightedPipelineUsd = 0;
  let wonValueUsd = 0;
  let awardedCount = 0;
  let lostCount = 0;
  let activePursuits = 0;

  for (const r of pursuitRows) {
    const stage = r.stage as PursuitStageKey;
    const stageBreakdown = byStage.get(stage);
    const valueUsd = Number.parseFloat(r.valueEstimateUsd ?? '0') || 0;
    const pWin = Number.parseFloat(r.pWin ?? '0') || 0;
    const weighted = valueUsd * pWin;

    if (stageBreakdown) {
      stageBreakdown.count += 1;
      stageBreakdown.totalValueUsd += valueUsd;
      stageBreakdown.weightedValueUsd += weighted;
    }

    if (stage === 'awarded') {
      awardedCount += 1;
      wonValueUsd += Number.parseFloat(r.awardedAmount ?? '0') || valueUsd;
    } else if (stage === 'lost') {
      lostCount += 1;
    } else {
      activePursuits += 1;
      pipelineValueUsd += valueUsd;
      weightedPipelineUsd += weighted;
    }

    const jurKey = r.jurisdictionId;
    const jur = jurisdictionAgg.get(jurKey) ?? {
      name: r.jurisdictionName,
      countryCode: r.jurisdictionCountry,
      pursuitCount: 0,
      wonCount: 0,
    };
    jur.pursuitCount += 1;
    if (stage === 'awarded') jur.wonCount += 1;
    jurisdictionAgg.set(jurKey, jur);

    if (r.category) {
      const cat = categoryAgg.get(r.category) ?? { pursuitCount: 0, wonCount: 0 };
      cat.pursuitCount += 1;
      if (stage === 'awarded') cat.wonCount += 1;
      categoryAgg.set(r.category, cat);
    }
  }

  const decided = awardedCount + lostCount;
  const winRate = decided > 0 ? awardedCount / decided : 0;

  const contractStats = await db
    .select({
      contractCount: sql<number>`count(*)::int`,
      activeContractValueUsd: sql<number>`COALESCE(SUM(CASE WHEN ${contracts.status} = 'active' THEN COALESCE(${contracts.totalValueUsd}::numeric, 0) ELSE 0 END), 0)::float`,
    })
    .from(contracts)
    .where(eq(contracts.companyId, companyId));

  const ppStats = await db
    .select({ pastPerformanceCount: sql<number>`count(*)::int` })
    .from(pastPerformance)
    .where(
      and(
        eq(pastPerformance.companyId, companyId),
        isNotNull(pastPerformance.projectName),
      ),
    );

  const contractCount = contractStats[0]?.contractCount ?? 0;
  const activeContractValueUsd = contractStats[0]?.activeContractValueUsd ?? 0;
  const pastPerformanceCount = ppStats[0]?.pastPerformanceCount ?? 0;

  return {
    totalPursuits: pursuitRows.length,
    activePursuits,
    awardedCount,
    lostCount,
    winRate,
    pipelineValueUsd,
    weightedPipelineUsd,
    wonValueUsd,
    stageBreakdown: STAGE_ORDER.map((s) => byStage.get(s)!),
    topJurisdictions: Array.from(jurisdictionAgg.values())
      .sort((a, b) => b.pursuitCount - a.pursuitCount)
      .slice(0, 6),
    topCategories: Array.from(categoryAgg.entries())
      .map(([category, agg]) => ({ category, ...agg }))
      .sort((a, b) => b.pursuitCount - a.pursuitCount)
      .slice(0, 6),
    contractCount,
    activeContractValueUsd,
    pastPerformanceCount,
  };
}
