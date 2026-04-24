import 'server-only';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  laborCategories,
  opportunities,
  pricingModels,
  pursuits,
  type LaborCategory,
  type PricingModel,
} from '@procur/db';

export type PricerListRow = {
  pursuitId: string;
  opportunityId: string;
  opportunityTitle: string;
  jurisdictionName: string;
  jurisdictionCountry: string;
  agencyName: string | null;
  deadlineAt: Date | null;
  pricingModelId: string | null;
  targetValue: string | null;
  currency: string | null;
  laborCategoriesCount: number;
  updatedAt: Date;
};

export async function listPricerPursuits(companyId: string): Promise<PricerListRow[]> {
  const rows = await db
    .select({
      pursuitId: pursuits.id,
      opportunityId: opportunities.id,
      opportunityTitle: opportunities.title,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      deadlineAt: opportunities.deadlineAt,
      pricingModelId: pricingModels.id,
      targetValue: pricingModels.targetValue,
      currency: pricingModels.currency,
      updatedAt: pricingModels.updatedAt,
      pursuitUpdatedAt: pursuits.updatedAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .leftJoin(pricingModels, eq(pricingModels.pursuitId, pursuits.id))
    .where(
      and(
        eq(pursuits.companyId, companyId),
        inArray(pursuits.stage, [
          'capture_planning',
          'proposal_development',
          'submitted',
          'awarded',
          'lost',
        ]),
      ),
    )
    .orderBy(desc(pursuits.updatedAt));

  // Count labor categories per pricing model
  const modelIds = rows
    .map((r) => r.pricingModelId)
    .filter((id): id is string => !!id);
  let countByModel = new Map<string, number>();
  if (modelIds.length > 0) {
    const counts = await db
      .select({ id: laborCategories.pricingModelId })
      .from(laborCategories)
      .where(inArray(laborCategories.pricingModelId, modelIds));
    countByModel = counts.reduce((acc, c) => {
      acc.set(c.id, (acc.get(c.id) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());
  }

  return rows.map((r) => ({
    pursuitId: r.pursuitId,
    opportunityId: r.opportunityId,
    opportunityTitle: r.opportunityTitle,
    jurisdictionName: r.jurisdictionName,
    jurisdictionCountry: r.jurisdictionCountry,
    agencyName: r.agencyName,
    deadlineAt: r.deadlineAt,
    pricingModelId: r.pricingModelId,
    targetValue: r.targetValue,
    currency: r.currency,
    laborCategoriesCount: r.pricingModelId ? countByModel.get(r.pricingModelId) ?? 0 : 0,
    updatedAt: r.updatedAt ?? r.pursuitUpdatedAt,
  }));
}

export type PricerDetail = {
  pricingModel: PricingModel | null;
  laborCategories: LaborCategory[];
  pursuit: {
    id: string;
    companyId: string;
    stage: string;
  };
  opportunity: {
    id: string;
    title: string;
    jurisdictionName: string;
    jurisdictionCountry: string;
    agencyName: string | null;
    valueEstimate: string | null;
    valueEstimateUsd: string | null;
    currency: string | null;
    deadlineAt: Date | null;
  };
};

export async function getPricerByPursuitId(
  companyId: string,
  pursuitId: string,
): Promise<PricerDetail | null> {
  const [row] = await db
    .select({
      pursuitId: pursuits.id,
      pursuitCompanyId: pursuits.companyId,
      pursuitStage: pursuits.stage,
      oppId: opportunities.id,
      oppTitle: opportunities.title,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      valueEstimate: opportunities.valueEstimate,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      currency: opportunities.currency,
      deadlineAt: opportunities.deadlineAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)))
    .limit(1);

  if (!row) return null;

  const pricingModel = await db.query.pricingModels.findFirst({
    where: eq(pricingModels.pursuitId, pursuitId),
  });

  const lcs = pricingModel
    ? await db
        .select()
        .from(laborCategories)
        .where(eq(laborCategories.pricingModelId, pricingModel.id))
    : [];

  return {
    pricingModel: pricingModel ?? null,
    laborCategories: lcs,
    pursuit: {
      id: row.pursuitId,
      companyId: row.pursuitCompanyId,
      stage: row.pursuitStage,
    },
    opportunity: {
      id: row.oppId,
      title: row.oppTitle,
      jurisdictionName: row.jurisdictionName,
      jurisdictionCountry: row.jurisdictionCountry,
      agencyName: row.agencyName,
      valueEstimate: row.valueEstimate,
      valueEstimateUsd: row.valueEstimateUsd,
      currency: row.currency,
      deadlineAt: row.deadlineAt,
    },
  };
}


// --- Calculations ---
// Pure pricing math lives in ./pricer-math.ts (no server-only marker) so
// client components like the Indirect Rates slider panel can import the
// buildup helpers without pulling server-only into the client bundle.
// Re-exported here so existing server-side imports continue to work.

export {
  wrapRateFor,
  calculateLaborCategory,
  summarize,
  aggregateYearTotals,
  buildIndirectBuildup,
} from './pricer-math';

export type {
  YearBreakdown,
  LaborCategoryCalculation,
  PricingSummary,
  YearTotal,
  CostBuildupLayer,
  CostBuildup,
} from './pricer-math';

export type HistoricalBenchmark = {
  sampleSize: number;
  minUsd: number;
  maxUsd: number;
  medianUsd: number;
  meanUsd: number;
  byAgencyCount: number;
  sameJurisdictionCount: number;
};

/**
 * Summarize past awarded opportunities in the same category (and optionally
 * same jurisdiction / agency) to help the user anchor the pricing model.
 */
export async function getHistoricalBenchmark(
  category: string | null,
  jurisdictionId: string | null,
  agencyId: string | null,
): Promise<HistoricalBenchmark | null> {
  if (!category) return null;

  const rows = await db
    .select({
      awardedAmount: opportunities.awardedAmount,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      currency: opportunities.currency,
      jurisdictionId: opportunities.jurisdictionId,
      agencyId: opportunities.agencyId,
    })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.status, 'awarded'),
        eq(opportunities.category, category),
        isNotNull(opportunities.awardedAmount),
      ),
    )
    .limit(500);

  if (rows.length === 0) return null;

  // Prefer awardedAmount; otherwise fall back to estimate in USD terms.
  // Use valueEstimateUsd as the USD proxy; if neither present, skip.
  const valuesUsd: number[] = [];
  let byAgency = 0;
  let sameJurisdiction = 0;
  for (const r of rows) {
    const usd = Number.parseFloat(r.valueEstimateUsd ?? '0');
    if (Number.isFinite(usd) && usd > 0) valuesUsd.push(usd);
    if (agencyId && r.agencyId === agencyId) byAgency += 1;
    if (jurisdictionId && r.jurisdictionId === jurisdictionId) sameJurisdiction += 1;
  }
  if (valuesUsd.length === 0) return null;

  const sorted = [...valuesUsd].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : sorted[mid] ?? 0;
  const mean = valuesUsd.reduce((a, b) => a + b, 0) / valuesUsd.length;

  return {
    sampleSize: valuesUsd.length,
    minUsd: Math.round(sorted[0] ?? 0),
    maxUsd: Math.round(sorted[sorted.length - 1] ?? 0),
    medianUsd: Math.round(median),
    meanUsd: Math.round(mean),
    byAgencyCount: byAgency,
    sameJurisdictionCount: sameJurisdiction,
  };
}

