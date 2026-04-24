'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  db,
  laborCategories,
  pricingModels,
  pursuits,
  type NewLaborCategory,
  type NewPricingModel,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import {
  calculateLaborCategory,
  wrapRateFor,
} from '../../lib/pricer-queries';

type PricingStrategy = 'labor_hours' | 'firm_fixed_price' | 'cost_plus' | 'time_materials';
const STRATEGIES: PricingStrategy[] = [
  'labor_hours',
  'firm_fixed_price',
  'cost_plus',
  'time_materials',
];

function toNumeric(v: FormDataEntryValue | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? String(n) : null;
}

function toInt(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

async function requirePricingModelForPursuit(
  companyId: string,
  pursuitId: string,
) {
  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('pursuit not found');
  const pricingModel = await db.query.pricingModels.findFirst({
    where: eq(pricingModels.pursuitId, pursuitId),
  });
  if (!pricingModel) throw new Error('pricing model not found');
  return { pursuit, pricingModel };
}

export async function createPricingModelAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const strategyRaw = String(formData.get('pricingStrategy') ?? 'labor_hours');
  const strategy: PricingStrategy = STRATEGIES.includes(strategyRaw as PricingStrategy)
    ? (strategyRaw as PricingStrategy)
    : 'labor_hours';
  if (!pursuitId) throw new Error('pursuitId required');

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const existing = await db.query.pricingModels.findFirst({
    where: eq(pricingModels.pursuitId, pursuitId),
  });
  if (existing) redirect(`/pricer/${pursuitId}`);

  const row: NewPricingModel = {
    pursuitId,
    pricingStrategy: strategy,
    basePeriodMonths: 12,
    optionYears: 0,
    hoursPerFte: 2080,
    currency: 'USD',
  };
  await db.insert(pricingModels).values(row);

  revalidatePath('/pricer');
  revalidatePath(`/pricer/${pursuitId}`);
  redirect(`/pricer/${pursuitId}`);
}

export async function updatePricingModelAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  const strategyRaw = String(formData.get('pricingStrategy') ?? pricingModel.pricingStrategy);
  const strategy: PricingStrategy = STRATEGIES.includes(strategyRaw as PricingStrategy)
    ? (strategyRaw as PricingStrategy)
    : (pricingModel.pricingStrategy as PricingStrategy);

  await db
    .update(pricingModels)
    .set({
      pricingStrategy: strategy,
      basePeriodMonths: toInt(formData.get('basePeriodMonths')) ?? pricingModel.basePeriodMonths,
      optionYears: toInt(formData.get('optionYears')) ?? pricingModel.optionYears,
      escalationRate: toNumeric(formData.get('escalationRate')) ?? pricingModel.escalationRate,
      hoursPerFte: toInt(formData.get('hoursPerFte')) ?? pricingModel.hoursPerFte,
      governmentEstimate:
        toNumeric(formData.get('governmentEstimate')) ?? pricingModel.governmentEstimate,
      ceilingValue: toNumeric(formData.get('ceilingValue')) ?? pricingModel.ceilingValue,
      targetFeePct: toNumeric(formData.get('targetFeePct')) ?? pricingModel.targetFeePct,
      fringeRate: toNumeric(formData.get('fringeRate')) ?? pricingModel.fringeRate,
      overheadRate: toNumeric(formData.get('overheadRate')) ?? pricingModel.overheadRate,
      gaRate: toNumeric(formData.get('gaRate')) ?? pricingModel.gaRate,
      currency: String(formData.get('currency') ?? pricingModel.currency ?? 'USD') || 'USD',
      fxRateToUsd: toNumeric(formData.get('fxRateToUsd')) ?? pricingModel.fxRateToUsd,
      notes: String(formData.get('notes') ?? pricingModel.notes ?? '') || null,
      updatedAt: new Date(),
    })
    .where(eq(pricingModels.id, pricingModel.id));

  await recomputeWrapAndLaborTotals(pricingModel.id);

  revalidatePath(`/pricer/${pursuitId}`);
}

export async function addLaborCategoryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  const title = String(formData.get('title') ?? '').trim();
  if (!title) throw new Error('title required');

  const row: NewLaborCategory = {
    pricingModelId: pricingModel.id,
    title,
    type: String(formData.get('type') ?? '') || null,
    directRate: toNumeric(formData.get('directRate')) ?? '0',
    hoursPerYear: toInt(formData.get('hoursPerYear')) ?? 2080,
  };
  await db.insert(laborCategories).values(row);

  await recomputeWrapAndLaborTotals(pricingModel.id);

  revalidatePath(`/pricer/${pursuitId}`);
}

export async function updateLaborCategoryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const lcId = String(formData.get('laborCategoryId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  const lc = await db.query.laborCategories.findFirst({
    where: and(
      eq(laborCategories.id, lcId),
      eq(laborCategories.pricingModelId, pricingModel.id),
    ),
  });
  if (!lc) throw new Error('labor category not found');

  await db
    .update(laborCategories)
    .set({
      title: String(formData.get('title') ?? lc.title),
      type: String(formData.get('type') ?? lc.type ?? '') || null,
      directRate: toNumeric(formData.get('directRate')) ?? lc.directRate,
      hoursPerYear: toInt(formData.get('hoursPerYear')) ?? lc.hoursPerYear,
      updatedAt: new Date(),
    })
    .where(eq(laborCategories.id, lcId));

  await recomputeWrapAndLaborTotals(pricingModel.id);

  revalidatePath(`/pricer/${pursuitId}`);
}

export async function removeLaborCategoryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const lcId = String(formData.get('laborCategoryId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  await db
    .delete(laborCategories)
    .where(
      and(
        eq(laborCategories.id, lcId),
        eq(laborCategories.pricingModelId, pricingModel.id),
      ),
    );

  await recomputeWrapAndLaborTotals(pricingModel.id);

  revalidatePath(`/pricer/${pursuitId}`);
}

/**
 * Recompute the yearlyBreakdown + totalCost for every labor category and
 * bubble up the pricingModel.targetValue and wrapRate. Runs after any change
 * that could affect the calculation (rates, strategy, LC add/edit/remove).
 */
async function recomputeWrapAndLaborTotals(pricingModelId: string): Promise<void> {
  const pricingModel = await db.query.pricingModels.findFirst({
    where: eq(pricingModels.id, pricingModelId),
  });
  if (!pricingModel) return;

  const fringe = Number.parseFloat(pricingModel.fringeRate ?? '0') || 0;
  const overhead = Number.parseFloat(pricingModel.overheadRate ?? '0') || 0;
  const ga = Number.parseFloat(pricingModel.gaRate ?? '0') || 0;
  const escalation = Number.parseFloat(pricingModel.escalationRate ?? '0') || 0;
  const targetFeePct = Number.parseFloat(pricingModel.targetFeePct ?? '0') || 0;
  const basePeriodMonths = pricingModel.basePeriodMonths ?? 12;
  const optionYears = pricingModel.optionYears ?? 0;
  const periodYears = Math.max(1, Math.ceil(basePeriodMonths / 12) + optionYears);
  const wrap = wrapRateFor(fringe, overhead, ga);

  const lcs = await db
    .select()
    .from(laborCategories)
    .where(eq(laborCategories.pricingModelId, pricingModelId));

  let laborTotal = 0;
  for (const lc of lcs) {
    const calc = calculateLaborCategory(lc, wrap, escalation, periodYears);
    laborTotal += calc.totalCost;
    await db
      .update(laborCategories)
      .set({
        loadedRate: String(calc.loadedRate),
        yearlyBreakdown: calc.yearlyBreakdown,
        totalCost: String(calc.totalCost),
        updatedAt: new Date(),
      })
      .where(eq(laborCategories.id, lc.id));
  }

  const targetValue = laborTotal * (1 + targetFeePct / 100);

  await db
    .update(pricingModels)
    .set({
      wrapRate: String(Number(wrap.toFixed(4))),
      targetValue: String(Number(targetValue.toFixed(2))),
      updatedAt: new Date(),
    })
    .where(eq(pricingModels.id, pricingModelId));
}
