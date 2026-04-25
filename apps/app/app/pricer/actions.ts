'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  agencies,
  db,
  jurisdictions,
  laborCategories,
  LABOR_RATE_SOURCES,
  LINE_ITEM_CATEGORIES,
  opportunities,
  pricingLineItems,
  pricingModels,
  pursuits,
  type LaborRateSource,
  type LineItemCategory,
  type NewLaborCategory,
  type NewPricingLineItem,
  type NewPricingModel,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { extractPricingStructure, meter, MODELS } from '@procur/ai';
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

/**
 * Validate user-supplied rate-source strings against the canonical
 * LABOR_RATE_SOURCES set. Empty/invalid → null (fallback rendered as
 * "manual" by the UI so existing rows don't suddenly lose a value).
 */
function toRateSource(v: FormDataEntryValue | null): LaborRateSource | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return (LABOR_RATE_SOURCES as readonly string[]).includes(s)
    ? (s as LaborRateSource)
    : null;
}

/**
 * Coerce a posted value to a valid indirect-rate mode, falling back
 * to the prior persisted value when the input is missing or unrecognized.
 * Treating an unrecognized string as "leave alone" prevents a stray
 * form submission from accidentally flipping the mode.
 */
function toIndirectMode(
  v: FormDataEntryValue | null,
  fallback: 'multiplicative' | 'additive',
): 'multiplicative' | 'additive' {
  if (v == null) return fallback;
  const s = String(v).trim();
  if (s === 'multiplicative' || s === 'additive') return s;
  return fallback;
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
      indirectRateMode: toIndirectMode(formData.get('indirectRateMode'), pricingModel.indirectRateMode),
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
    rateSource: toRateSource(formData.get('rateSource')),
    rateSourceReference: String(formData.get('rateSourceReference') ?? '').trim() || null,
    description: String(formData.get('description') ?? '').trim() || null,
    requirementsCertifications:
      String(formData.get('requirementsCertifications') ?? '').trim() || null,
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

  // For fields that may be intentionally cleared (rate source reference,
  // description, requirements), we need to distinguish "field absent from
  // form" from "field cleared". Each inline edit form we ship omits the
  // fields it doesn't touch, so "absent" → keep existing; "present but
  // empty" → clear.
  const hasRateSource = formData.has('rateSource');
  const hasRateSourceRef = formData.has('rateSourceReference');
  const hasDescription = formData.has('description');
  const hasReqs = formData.has('requirementsCertifications');

  await db
    .update(laborCategories)
    .set({
      title: String(formData.get('title') ?? lc.title),
      type: String(formData.get('type') ?? lc.type ?? '') || null,
      directRate: toNumeric(formData.get('directRate')) ?? lc.directRate,
      hoursPerYear: toInt(formData.get('hoursPerYear')) ?? lc.hoursPerYear,
      rateSource: hasRateSource ? toRateSource(formData.get('rateSource')) : lc.rateSource,
      rateSourceReference: hasRateSourceRef
        ? String(formData.get('rateSourceReference') ?? '').trim() || null
        : lc.rateSourceReference,
      description: hasDescription
        ? String(formData.get('description') ?? '').trim() || null
        : lc.description,
      requirementsCertifications: hasReqs
        ? String(formData.get('requirementsCertifications') ?? '').trim() || null
        : lc.requirementsCertifications,
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
  const wrap = wrapRateFor(fringe, overhead, ga, pricingModel.indirectRateMode);

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

type FinancialRequirement = {
  type: string;
  text: string;
  mandatory: boolean;
};

export async function extractPricingStructureAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  const [row] = await db
    .select({
      oppTitle: opportunities.title,
      oppDescription: opportunities.description,
      oppReferenceNumber: opportunities.referenceNumber,
      jurisdictionName: jurisdictions.name,
      agencyName: agencies.name,
      extractedRequirements: opportunities.extractedRequirements,
      mandatoryDocuments: opportunities.mandatoryDocuments,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(pursuits.id, pursuitId))
    .limit(1);
  if (!row) throw new Error('opportunity not found');

  const reqs = (row.extractedRequirements as FinancialRequirement[] | null) ?? [];
  const mandatoryDocs = (row.mandatoryDocuments as string[] | null) ?? [];

  const result = await extractPricingStructure({
    opportunity: {
      title: row.oppTitle,
      jurisdictionName: row.jurisdictionName,
      agencyName: row.agencyName,
      description: row.oppDescription,
      referenceNumber: row.oppReferenceNumber,
    },
    extractedRequirements: reqs,
    mandatoryDocuments: mandatoryDocs,
  });
  await meter({
    companyId: company.id,
    source: 'extract_pricing',
    model: MODELS.sonnet,
    usage: result.usage,
  });

  // Apply suggestions, merging with existing values (user-set values win)
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (!pricingModel.pricingStrategy || pricingModel.pricingStrategy === 'labor_hours') {
    updates.pricingStrategy = result.suggestedStrategy;
  }
  if (!pricingModel.currency || pricingModel.currency === 'USD') {
    updates.currency = result.suggestedCurrency;
  }
  if (result.basePeriodMonths && pricingModel.basePeriodMonths === 12) {
    updates.basePeriodMonths = result.basePeriodMonths;
  }
  if (result.optionYears != null && (pricingModel.optionYears ?? 0) === 0) {
    updates.optionYears = result.optionYears;
  }

  // Persist the raw suggestions as notes appendage so user can review
  const extractionNote = [
    '',
    '--- AI pricing suggestions ---',
    `Strategy: ${result.suggestedStrategy} — ${result.reasoning}`,
    `Currency: ${result.suggestedCurrency}`,
    result.basePeriodMonths ? `Base period: ${result.basePeriodMonths} months` : null,
    result.optionYears ? `Option years: ${result.optionYears}` : null,
    result.requiredPricingDeliverables.length > 0
      ? `Required pricing deliverables: ${result.requiredPricingDeliverables.join('; ')}`
      : null,
    result.indirectHints.notes ? `Indirect notes: ${result.indirectHints.notes}` : null,
    `Confidence: ${Math.round(result.confidence * 100)}%`,
  ]
    .filter(Boolean)
    .join('\n');
  updates.notes = (pricingModel.notes ?? '') + extractionNote;

  await db.update(pricingModels).set(updates).where(eq(pricingModels.id, pricingModel.id));

  // Add suggested labor categories that don't already exist (by title)
  if (result.suggestedLaborCategories.length > 0) {
    const existing = await db
      .select({ title: laborCategories.title })
      .from(laborCategories)
      .where(eq(laborCategories.pricingModelId, pricingModel.id));
    const existingTitles = new Set(existing.map((e) => e.title.toLowerCase()));
    const toInsert = result.suggestedLaborCategories
      .filter((lc) => !existingTitles.has(lc.title.toLowerCase()))
      .map((lc) => ({
        pricingModelId: pricingModel.id,
        title: lc.title,
        type: lc.type,
        directRate: '0',
        hoursPerYear: 2080,
      }));
    if (toInsert.length > 0) {
      await db.insert(laborCategories).values(toInsert);
    }
  }

  await recomputeWrapAndLaborTotals(pricingModel.id);
  revalidatePath(`/pricer/${pursuitId}`);
}

// ===========================================================================
// Non-labor line items (ODC / travel / materials / subcontract / other)
// ===========================================================================

function toCategory(v: FormDataEntryValue | null): LineItemCategory {
  const s = v == null ? '' : String(v).trim();
  return (LINE_ITEM_CATEGORIES as readonly string[]).includes(s)
    ? (s as LineItemCategory)
    : 'other';
}

async function requireLineItemForPursuit(
  companyId: string,
  pursuitId: string,
  lineItemId: string,
) {
  const { pricingModel } = await requirePricingModelForPursuit(companyId, pursuitId);
  const li = await db.query.pricingLineItems.findFirst({
    where: and(
      eq(pricingLineItems.id, lineItemId),
      eq(pricingLineItems.pricingModelId, pricingModel.id),
    ),
  });
  if (!li) throw new Error('line item not found');
  return { li, pricingModel };
}

export async function addLineItemAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const { pricingModel } = await requirePricingModelForPursuit(company.id, pursuitId);

  const title = String(formData.get('title') ?? '').trim();
  if (!title) throw new Error('title required');

  const row: NewPricingLineItem = {
    pricingModelId: pricingModel.id,
    title,
    category: toCategory(formData.get('category')),
    clinNumber: String(formData.get('clinNumber') ?? '').trim() || null,
    quantity: toNumeric(formData.get('quantity')),
    unitOfMeasure: String(formData.get('unitOfMeasure') ?? '').trim() || null,
    unitPrice: toNumeric(formData.get('unitPrice')),
    amount: toNumeric(formData.get('amount')),
    startDate: String(formData.get('startDate') ?? '').trim() || null,
    endDate: String(formData.get('endDate') ?? '').trim() || null,
    notes: String(formData.get('notes') ?? '').trim() || null,
  };
  await db.insert(pricingLineItems).values(row);

  revalidatePath(`/pricer/${pursuitId}`);
}

export async function updateLineItemAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const lineItemId = String(formData.get('lineItemId') ?? '');
  if (!lineItemId) throw new Error('lineItemId required');

  const { li } = await requireLineItemForPursuit(company.id, pursuitId, lineItemId);

  // Use formData.has() so per-field inline edits don't blank unrelated
  // columns — same pattern as the labor-category action.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('title')) patch.title = String(formData.get('title') ?? li.title).trim() || li.title;
  if (formData.has('category')) patch.category = toCategory(formData.get('category'));
  if (formData.has('clinNumber'))
    patch.clinNumber = String(formData.get('clinNumber') ?? '').trim() || null;
  if (formData.has('quantity')) patch.quantity = toNumeric(formData.get('quantity'));
  if (formData.has('unitOfMeasure'))
    patch.unitOfMeasure = String(formData.get('unitOfMeasure') ?? '').trim() || null;
  if (formData.has('unitPrice')) patch.unitPrice = toNumeric(formData.get('unitPrice'));
  if (formData.has('amount')) patch.amount = toNumeric(formData.get('amount'));
  if (formData.has('startDate'))
    patch.startDate = String(formData.get('startDate') ?? '').trim() || null;
  if (formData.has('endDate'))
    patch.endDate = String(formData.get('endDate') ?? '').trim() || null;
  if (formData.has('notes')) patch.notes = String(formData.get('notes') ?? '').trim() || null;

  await db.update(pricingLineItems).set(patch).where(eq(pricingLineItems.id, lineItemId));

  revalidatePath(`/pricer/${pursuitId}`);
}

export async function removeLineItemAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const lineItemId = String(formData.get('lineItemId') ?? '');
  if (!lineItemId) throw new Error('lineItemId required');

  // Ownership check before delete.
  await requireLineItemForPursuit(company.id, pursuitId, lineItemId);

  await db.delete(pricingLineItems).where(eq(pricingLineItems.id, lineItemId));

  revalidatePath(`/pricer/${pursuitId}`);
}
