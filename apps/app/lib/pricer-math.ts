/**
 * Pure pricing math. No `server-only` marker, no DB access — safe to
 * import from client components (e.g. the indirect-rates slider panel)
 * without pulling server modules into the client bundle.
 *
 * Re-exported from `pricer-queries.ts` so existing server imports keep
 * working unchanged.
 */
import type { LaborCategory, PricingModel } from '@procur/db';

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

export type YearTotal = { year: number; cost: number };

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
 * Year-by-Year Costs row on the Labor Categories tab.
 */
export function aggregateYearTotals(calcs: LaborCategoryCalculation[]): YearTotal[] {
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
 *
 * Mode = 'multiplicative' applies rates in series (matches the
 * wrapRateFor formula). Mode = 'additive' sums the rate impacts on
 * Direct Labor. Both modes are computed so the UI can show a live
 * preview of the alternate mode alongside.
 */
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
