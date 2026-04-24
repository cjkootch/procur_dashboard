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

export type YearBreakdown = {
  year: number;
  rate: number;
  hours: number;
  cost: number;
};

export type LaborCategoryCalculation = {
  id: string;
  title: string;
  directRate: number;
  loadedRate: number;
  hoursPerYear: number;
  yearlyBreakdown: YearBreakdown[];
  totalCost: number;
};

export type PricingSummary = {
  wrapRate: number;
  totalLaborCost: number;
  targetFee: number;
  totalValue: number;
  totalValueUsd: number | null;
  periodYears: number;
};

export function wrapRateFor(
  fringePct: number,
  overheadPct: number,
  gaPct: number,
): number {
  return (1 + fringePct / 100) * (1 + overheadPct / 100) * (1 + gaPct / 100);
}

export function calculateLaborCategory(
  lc: LaborCategory,
  wrap: number,
  escalationPct: number,
  periodYears: number,
): LaborCategoryCalculation {
  const directRate = Number.parseFloat(lc.directRate ?? '0') || 0;
  const hoursPerYear = lc.hoursPerYear ?? 0;
  const loadedRate = directRate * wrap;

  const yearlyBreakdown: YearBreakdown[] = [];
  let totalCost = 0;
  for (let y = 1; y <= periodYears; y += 1) {
    const rate = loadedRate * Math.pow(1 + escalationPct / 100, y - 1);
    const cost = rate * hoursPerYear;
    yearlyBreakdown.push({
      year: y,
      rate: Number(rate.toFixed(2)),
      hours: hoursPerYear,
      cost: Number(cost.toFixed(2)),
    });
    totalCost += cost;
  }

  return {
    id: lc.id,
    title: lc.title,
    directRate,
    loadedRate: Number(loadedRate.toFixed(2)),
    hoursPerYear,
    yearlyBreakdown,
    totalCost: Number(totalCost.toFixed(2)),
  };
}

export function summarize(
  pricingModel: PricingModel,
  lcs: LaborCategory[],
): PricingSummary & { laborCategories: LaborCategoryCalculation[] } {
  const fringe = Number.parseFloat(pricingModel.fringeRate ?? '0') || 0;
  const overhead = Number.parseFloat(pricingModel.overheadRate ?? '0') || 0;
  const ga = Number.parseFloat(pricingModel.gaRate ?? '0') || 0;
  const escalation = Number.parseFloat(pricingModel.escalationRate ?? '0') || 0;
  const targetFeePct = Number.parseFloat(pricingModel.targetFeePct ?? '0') || 0;
  const basePeriodMonths = pricingModel.basePeriodMonths ?? 12;
  const optionYears = pricingModel.optionYears ?? 0;
  const periodYears = Math.max(1, Math.ceil(basePeriodMonths / 12) + optionYears);
  const fxRate = Number.parseFloat(pricingModel.fxRateToUsd ?? '1') || 1;

  const wrap = wrapRateFor(fringe, overhead, ga);
  const calculated = lcs.map((lc) => calculateLaborCategory(lc, wrap, escalation, periodYears));
  const totalLaborCost = calculated.reduce((sum, c) => sum + c.totalCost, 0);
  const targetFee = totalLaborCost * (targetFeePct / 100);
  const totalValue = totalLaborCost + targetFee;
  const totalValueUsd = pricingModel.currency === 'USD' ? totalValue : totalValue * fxRate;

  return {
    wrapRate: Number(wrap.toFixed(4)),
    totalLaborCost: Number(totalLaborCost.toFixed(2)),
    targetFee: Number(targetFee.toFixed(2)),
    totalValue: Number(totalValue.toFixed(2)),
    totalValueUsd: totalValueUsd ? Number(totalValueUsd.toFixed(2)) : null,
    periodYears,
    laborCategories: calculated,
  };
}

/**
 * Aggregate per-year totals across all labor categories. Used by the
 * Labor Cost Summary block on the Labor Categories tab to render a
 * "Year-by-Year Costs" row (Base + Option Years 1-N).
 */
export type YearTotal = { year: number; cost: number };

export function aggregateYearTotals(
  calcs: LaborCategoryCalculation[],
): YearTotal[] {
  const byYear = new Map<number, number>();
  for (const c of calcs) {
    for (const yb of c.yearlyBreakdown) {
      byYear.set(yb.year, (byYear.get(yb.year) ?? 0) + yb.cost);
    }
  }
  return Array.from(byYear.entries())
    .map(([year, cost]) => ({ year, cost: Number(cost.toFixed(2)) }))
    .sort((a, b) => a.year - b.year);
}

/**
 * Layered cost buildup used by the Indirect Rates tab's preview panel.
 * Returns the running cost after each indirect rate is applied, in the
 * order they're applied, so the UI can show the same step-by-step view
 * GovDash uses.
 *
 * Mode = 'multiplicative' applies rates in series (the existing wrapRate
 * formula). Mode = 'additive' sums the rate impacts on Direct Labor. We
 * compute both so the UI can show them side-by-side.
 */
export type CostBuildupLayer = {
  label: string;
  amount: number;
  appliedTo: string;
  ratePct: number;
};

export type CostBuildup = {
  mode: 'multiplicative' | 'additive';
  layers: CostBuildupLayer[];
  totalLoaded: number;
};

export function buildIndirectBuildup(input: {
  directLabor: number;
  fringePct: number;
  overheadPct: number;
  gaPct: number;
  mode: 'multiplicative' | 'additive';
}): CostBuildup {
  const { directLabor, fringePct, overheadPct, gaPct, mode } = input;
  const layers: CostBuildupLayer[] = [
    { label: 'Direct Labor', amount: directLabor, appliedTo: 'Base', ratePct: 0 },
  ];

  if (mode === 'multiplicative') {
    const fringe = directLabor * (fringePct / 100);
    const afterFringe = directLabor + fringe;
    layers.push({ label: 'Fringe Benefits', amount: fringe, appliedTo: 'Direct Labor', ratePct: fringePct });

    const overhead = afterFringe * (overheadPct / 100);
    const afterOverhead = afterFringe + overhead;
    layers.push({ label: 'Overhead', amount: overhead, appliedTo: 'Direct Labor + Fringe', ratePct: overheadPct });

    const ga = afterOverhead * (gaPct / 100);
    const afterGa = afterOverhead + ga;
    layers.push({ label: 'G&A', amount: ga, appliedTo: 'Total burdened', ratePct: gaPct });

    return { mode, layers, totalLoaded: Number(afterGa.toFixed(2)) };
  }

  // Additive: each rate applied to Direct Labor independently and summed.
  const fringe = directLabor * (fringePct / 100);
  const overhead = directLabor * (overheadPct / 100);
  const ga = directLabor * (gaPct / 100);
  layers.push({ label: 'Fringe Benefits', amount: fringe, appliedTo: 'Direct Labor', ratePct: fringePct });
  layers.push({ label: 'Overhead', amount: overhead, appliedTo: 'Direct Labor', ratePct: overheadPct });
  layers.push({ label: 'G&A', amount: ga, appliedTo: 'Direct Labor', ratePct: gaPct });
  const total = directLabor + fringe + overhead + ga;
  return { mode, layers, totalLoaded: Number(total.toFixed(2)) };
}

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

