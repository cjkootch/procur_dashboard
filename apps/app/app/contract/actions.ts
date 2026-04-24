'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'crypto';
import {
  agencies,
  contracts,
  db,
  jurisdictions,
  opportunities,
  pursuits,
  type NewContract,
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

function num(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
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
  const fx = Number.parseFloat(str(formData, 'fxRateToUsd') ?? '1') || 1;
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
  const fx = Number.parseFloat(str(formData, 'fxRateToUsd') ?? '1') || 1;
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
