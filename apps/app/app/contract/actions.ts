'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'crypto';
import {
  agencies,
  CLIN_TYPES,
  contracts,
  contractClins,
  contractModifications,
  contractTaskAreas,
  db,
  jurisdictions,
  MODIFICATION_ACTION_TYPES,
  opportunities,
  pursuits,
  type ClinType,
  type ContractClin,
  type ContractModification,
  type ContractTaskArea,
  type ModificationActionType,
  type NewContract,
  type NewContractClin,
  type NewContractModification,
  type NewContractTaskArea,
} from '@procur/db';
import { requireCompany } from '@procur/auth';

type ObligationFrequency = 'once' | 'monthly' | 'quarterly' | 'annually';
type ObligationStatus = 'pending' | 'in_progress' | 'completed' | 'overdue';
type Obligation = {
  id: string;
  description: string;
  dueDate?: string;
  frequency?: ObligationFrequency;
  status: ObligationStatus;
};

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/**
 * Non-negative dollar amount, 2 decimals. Rejects NaN AND signed values
 * — used for fields that physically cannot be negative (totalValue,
 * CLIN amount, CLIN unitPrice, quantity). Returns null for invalid
 * input so callers can choose to throw or just drop the field.
 *
 * For fields that legitimately carry a sign (modification funding
 * delta = obligation +/- de-obligation), use signedNum.
 */
/**
 * FX-rate coercion. Must be strictly positive — a negative rate would
 * silently flip the sign of totalValueUsd and bucket the row under
 * "No value set" in the contract reports. Falls back to 1.0 when the
 * input is missing, NaN, zero, or negative.
 */
function positiveFxRate(raw: string | null): number {
  if (!raw) return 1;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function num(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

async function requireOwnedContract(companyId: string, contractId: string) {
  const row = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)),
  });
  if (!row) throw new Error('contract not found');
  return row;
}

export async function createContractAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const awardTitle = str(formData, 'awardTitle');
  if (!awardTitle) throw new Error('awardTitle is required');

  const totalValue = num(formData, 'totalValue');
  const fx = positiveFxRate(str(formData, 'fxRateToUsd'));
  const currency = str(formData, 'currency')?.slice(0, 3).toUpperCase() ?? 'USD';

  const insertValues: NewContract = {
    companyId: company.id,
    awardTitle,
    tier: (str(formData, 'tier') as 'prime' | 'subcontract' | 'task_order' | null) ?? 'prime',
    contractNumber: str(formData, 'contractNumber'),
    parentContractNumber: str(formData, 'parentContractNumber'),
    taskOrderNumber: str(formData, 'taskOrderNumber'),
    subcontractNumber: str(formData, 'subcontractNumber'),
    awardingAgency: str(formData, 'awardingAgency'),
    primeContractor: str(formData, 'primeContractor'),
    awardDate: str(formData, 'awardDate'),
    startDate: str(formData, 'startDate'),
    endDate: str(formData, 'endDate'),
    totalValue,
    currency,
    totalValueUsd:
      totalValue && currency === 'USD'
        ? totalValue
        : totalValue
          ? (Number.parseFloat(totalValue) * fx).toFixed(2)
          : null,
    status: 'active',
    obligations: [],
    notes: str(formData, 'notes'),
  };

  const [inserted] = await db.insert(contracts).values(insertValues).returning({ id: contracts.id });
  revalidatePath('/contract');
  if (inserted) redirect(`/contract/${inserted.id}`);
}

export async function createContractFromPursuitAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = str(formData, 'pursuitId');
  if (!pursuitId) throw new Error('pursuitId required');

  const [row] = await db
    .select({
      pursuitId: pursuits.id,
      oppTitle: opportunities.title,
      jurisdictionName: jurisdictions.name,
      agencyName: agencies.name,
      valueEstimate: opportunities.valueEstimate,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      currency: opportunities.currency,
      awardedAmount: opportunities.awardedAmount,
      deadlineAt: opportunities.deadlineAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)))
    .limit(1);
  if (!row) throw new Error('pursuit not found');

  // Don't duplicate: if a contract already exists for this pursuit, redirect.
  const existing = await db.query.contracts.findFirst({
    where: and(eq(contracts.pursuitId, pursuitId), eq(contracts.companyId, company.id)),
  });
  if (existing) redirect(`/contract/${existing.id}`);

  const value = row.awardedAmount ?? row.valueEstimate;
  const currency = row.currency ?? 'USD';

  const [inserted] = await db
    .insert(contracts)
    .values({
      companyId: company.id,
      pursuitId,
      awardTitle: row.oppTitle,
      tier: 'prime',
      awardingAgency: row.agencyName ?? row.jurisdictionName,
      totalValue: value,
      currency,
      totalValueUsd: currency === 'USD' ? value : row.valueEstimateUsd,
      status: 'active',
      obligations: [],
    })
    .returning({ id: contracts.id });

  revalidatePath('/contract');
  revalidatePath(`/capture/pursuits/${pursuitId}`);
  if (inserted) redirect(`/contract/${inserted.id}`);
}

export async function updateContractAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwnedContract(company.id, id);

  const totalValue = num(formData, 'totalValue');
  const fx = positiveFxRate(str(formData, 'fxRateToUsd'));
  const currency = str(formData, 'currency')?.slice(0, 3).toUpperCase() ?? 'USD';

  await db
    .update(contracts)
    .set({
      awardTitle: str(formData, 'awardTitle') ?? 'Untitled contract',
      tier: (str(formData, 'tier') as 'prime' | 'subcontract' | 'task_order' | null) ?? 'prime',
      contractNumber: str(formData, 'contractNumber'),
      parentContractNumber: str(formData, 'parentContractNumber'),
      taskOrderNumber: str(formData, 'taskOrderNumber'),
      subcontractNumber: str(formData, 'subcontractNumber'),
      awardingAgency: str(formData, 'awardingAgency'),
      primeContractor: str(formData, 'primeContractor'),
      awardDate: str(formData, 'awardDate'),
      startDate: str(formData, 'startDate'),
      endDate: str(formData, 'endDate'),
      totalValue,
      currency,
      totalValueUsd:
        totalValue && currency === 'USD'
          ? totalValue
          : totalValue
            ? (Number.parseFloat(totalValue) * fx).toFixed(2)
            : null,
      status:
        (str(formData, 'status') as 'active' | 'completed' | 'terminated' | null) ?? 'active',
      notes: str(formData, 'notes'),
      updatedAt: new Date(),
    })
    .where(eq(contracts.id, id));

  revalidatePath(`/contract/${id}`);
  revalidatePath('/contract');
}

export async function deleteContractAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwnedContract(company.id, id);

  await db.delete(contracts).where(eq(contracts.id, id));
  revalidatePath('/contract');
  redirect('/contract');
}

async function setObligations(contractId: string, obligations: Obligation[]): Promise<void> {
  await db
    .update(contracts)
    .set({ obligations, updatedAt: new Date() })
    .where(eq(contracts.id, contractId));
  revalidatePath(`/contract/${contractId}`);
}

export async function addObligationAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const description = str(formData, 'description');
  if (!contractId || !description) throw new Error('contractId and description required');
  const contract = await requireOwnedContract(company.id, contractId);

  const obligations = [...(contract.obligations ?? [])];
  obligations.push({
    id: randomUUID(),
    description,
    dueDate: str(formData, 'dueDate') ?? undefined,
    frequency: (str(formData, 'frequency') as ObligationFrequency | null) ?? undefined,
    status: 'pending',
  });
  await setObligations(contractId, obligations);
}

export async function updateObligationStatusAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const obligationId = str(formData, 'obligationId');
  const status = str(formData, 'status') as ObligationStatus | null;
  if (!contractId || !obligationId || !status) {
    throw new Error('contractId, obligationId, status required');
  }
  const contract = await requireOwnedContract(company.id, contractId);

  const obligations = (contract.obligations ?? []).map((o) =>
    o.id === obligationId ? { ...o, status } : o,
  );
  await setObligations(contractId, obligations);
}

export async function removeObligationAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const obligationId = str(formData, 'obligationId');
  if (!contractId || !obligationId) throw new Error('contractId, obligationId required');
  const contract = await requireOwnedContract(company.id, contractId);

  const obligations = (contract.obligations ?? []).filter((o) => o.id !== obligationId);
  await setObligations(contractId, obligations);
}

// ===========================================================================
// Modifications
// ===========================================================================

function toModActionType(v: FormDataEntryValue | null): ModificationActionType {
  const s = v == null ? '' : String(v);
  return (MODIFICATION_ACTION_TYPES as string[]).includes(s)
    ? (s as ModificationActionType)
    : 'other';
}

function toClinType(v: FormDataEntryValue | null): ClinType {
  const s = v == null ? '' : String(v);
  return (CLIN_TYPES as string[]).includes(s) ? (s as ClinType) : 'fixed_price';
}

function dateOrNull(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  // HTML <input type="date"> emits YYYY-MM-DD which is what postgres date columns accept.
  return v;
}

/**
 * Signed dollar amount, 2 decimals. Used for modification.fundingChange
 * where negative values legitimately encode de-obligations. Use `num`
 * for fields that cannot be negative.
 */
function signedNum(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/**
 * Non-negative 4-decimal value (CLIN unit price, quantity). Same
 * rationale as `num` — these fields cannot legitimately be negative.
 */
function decimal4(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(4);
}

export async function addModificationAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const modNumber = str(formData, 'modNumber');
  if (!contractId || !modNumber) throw new Error('contractId + modNumber required');

  await requireOwnedContract(company.id, contractId);

  const row: NewContractModification = {
    contractId,
    modNumber,
    actionDate: dateOrNull(formData, 'actionDate'),
    actionType: toModActionType(formData.get('actionType')),
    description: str(formData, 'description'),
    fundingChange: signedNum(formData, 'fundingChange'),
    documentUrl: str(formData, 'documentUrl'),
    source: str(formData, 'source'),
  };

  await db.insert(contractModifications).values(row);
  revalidatePath(`/contract/${contractId}`);
}

async function requireOwnedModification(
  companyId: string,
  modificationId: string,
): Promise<ContractModification> {
  const rows = await db
    .select({ mod: contractModifications, companyId: contracts.companyId })
    .from(contractModifications)
    .innerJoin(contracts, eq(contracts.id, contractModifications.contractId))
    .where(eq(contractModifications.id, modificationId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('modification not found');
  return first.mod;
}

export async function updateModificationAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const modificationId = str(formData, 'modificationId');
  if (!modificationId) throw new Error('modificationId required');

  const existing = await requireOwnedModification(company.id, modificationId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('modNumber')) {
    const v = str(formData, 'modNumber');
    if (v) updates.modNumber = v;
  }
  if (formData.has('actionDate')) updates.actionDate = dateOrNull(formData, 'actionDate');
  if (formData.has('actionType')) updates.actionType = toModActionType(formData.get('actionType'));
  if (formData.has('description')) updates.description = str(formData, 'description');
  if (formData.has('fundingChange')) updates.fundingChange = signedNum(formData, 'fundingChange');
  if (formData.has('documentUrl')) updates.documentUrl = str(formData, 'documentUrl');
  if (formData.has('source')) updates.source = str(formData, 'source');

  await db
    .update(contractModifications)
    .set(updates)
    .where(eq(contractModifications.id, modificationId));

  revalidatePath(`/contract/${existing.contractId}`);
}

export async function removeModificationAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const modificationId = str(formData, 'modificationId');
  if (!modificationId) throw new Error('modificationId required');

  const existing = await requireOwnedModification(company.id, modificationId);

  await db.delete(contractModifications).where(eq(contractModifications.id, modificationId));

  revalidatePath(`/contract/${existing.contractId}`);
}

// ===========================================================================
// CLINs
// ===========================================================================

async function requireOwnedClin(companyId: string, clinId: string): Promise<ContractClin> {
  const rows = await db
    .select({ clin: contractClins, companyId: contracts.companyId })
    .from(contractClins)
    .innerJoin(contracts, eq(contracts.id, contractClins.contractId))
    .where(eq(contractClins.id, clinId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('clin not found');
  return first.clin;
}

export async function addClinAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const clinNumber = str(formData, 'clinNumber');
  const title = str(formData, 'title');
  if (!contractId || !clinNumber || !title) throw new Error('contractId + clinNumber + title required');

  await requireOwnedContract(company.id, contractId);

  const row: NewContractClin = {
    contractId,
    clinNumber,
    title,
    clinType: toClinType(formData.get('clinType')),
    quantity: decimal4(formData, 'quantity'),
    unitOfMeasure: str(formData, 'unitOfMeasure'),
    unitPrice: decimal4(formData, 'unitPrice'),
    amount: num(formData, 'amount'),
    periodStart: dateOrNull(formData, 'periodStart'),
    periodEnd: dateOrNull(formData, 'periodEnd'),
    notes: str(formData, 'notes'),
  };

  await db.insert(contractClins).values(row);
  revalidatePath(`/contract/${contractId}`);
}

export async function updateClinAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const clinId = str(formData, 'clinId');
  if (!clinId) throw new Error('clinId required');

  const existing = await requireOwnedClin(company.id, clinId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('clinNumber')) {
    const v = str(formData, 'clinNumber');
    if (v) updates.clinNumber = v;
  }
  if (formData.has('title')) {
    const v = str(formData, 'title');
    if (v) updates.title = v;
  }
  if (formData.has('clinType')) updates.clinType = toClinType(formData.get('clinType'));
  if (formData.has('quantity')) updates.quantity = decimal4(formData, 'quantity');
  if (formData.has('unitOfMeasure')) updates.unitOfMeasure = str(formData, 'unitOfMeasure');
  if (formData.has('unitPrice')) updates.unitPrice = decimal4(formData, 'unitPrice');
  if (formData.has('amount')) updates.amount = num(formData, 'amount');
  if (formData.has('periodStart')) updates.periodStart = dateOrNull(formData, 'periodStart');
  if (formData.has('periodEnd')) updates.periodEnd = dateOrNull(formData, 'periodEnd');
  if (formData.has('notes')) updates.notes = str(formData, 'notes');

  await db.update(contractClins).set(updates).where(eq(contractClins.id, clinId));

  revalidatePath(`/contract/${existing.contractId}`);
}

export async function removeClinAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const clinId = str(formData, 'clinId');
  if (!clinId) throw new Error('clinId required');

  const existing = await requireOwnedClin(company.id, clinId);
  await db.delete(contractClins).where(eq(contractClins.id, clinId));
  revalidatePath(`/contract/${existing.contractId}`);
}

// ===========================================================================
// Task Areas
// ===========================================================================

async function requireOwnedTaskArea(
  companyId: string,
  taskAreaId: string,
): Promise<ContractTaskArea> {
  const rows = await db
    .select({ ta: contractTaskAreas, companyId: contracts.companyId })
    .from(contractTaskAreas)
    .innerJoin(contracts, eq(contracts.id, contractTaskAreas.contractId))
    .where(eq(contractTaskAreas.id, taskAreaId))
    .limit(1);
  const first = rows[0];
  if (!first || first.companyId !== companyId) throw new Error('task area not found');
  return first.ta;
}

export async function addTaskAreaAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  const name = str(formData, 'name');
  if (!contractId || !name) throw new Error('contractId + name required');

  await requireOwnedContract(company.id, contractId);

  const row: NewContractTaskArea = {
    contractId,
    name,
    description: str(formData, 'description'),
    scope: str(formData, 'scope'),
    periodStart: dateOrNull(formData, 'periodStart'),
    periodEnd: dateOrNull(formData, 'periodEnd'),
    notes: str(formData, 'notes'),
  };

  await db.insert(contractTaskAreas).values(row);
  revalidatePath(`/contract/${contractId}`);
}

export async function updateTaskAreaAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const taskAreaId = str(formData, 'taskAreaId');
  if (!taskAreaId) throw new Error('taskAreaId required');

  const existing = await requireOwnedTaskArea(company.id, taskAreaId);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (formData.has('name')) {
    const v = str(formData, 'name');
    if (v) updates.name = v;
  }
  if (formData.has('description')) updates.description = str(formData, 'description');
  if (formData.has('scope')) updates.scope = str(formData, 'scope');
  if (formData.has('periodStart')) updates.periodStart = dateOrNull(formData, 'periodStart');
  if (formData.has('periodEnd')) updates.periodEnd = dateOrNull(formData, 'periodEnd');
  if (formData.has('notes')) updates.notes = str(formData, 'notes');

  await db.update(contractTaskAreas).set(updates).where(eq(contractTaskAreas.id, taskAreaId));

  revalidatePath(`/contract/${existing.contractId}`);
}

export async function removeTaskAreaAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const taskAreaId = str(formData, 'taskAreaId');
  if (!taskAreaId) throw new Error('taskAreaId required');

  const existing = await requireOwnedTaskArea(company.id, taskAreaId);
  await db.delete(contractTaskAreas).where(eq(contractTaskAreas.id, taskAreaId));
  revalidatePath(`/contract/${existing.contractId}`);
}
