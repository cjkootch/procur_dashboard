import 'server-only';
import { asc, eq } from 'drizzle-orm';
import {
  contractClins,
  contractModifications,
  contractTaskAreas,
  db,
  type ClinType,
  type ContractClin,
  type ContractModification,
  type ContractTaskArea,
  type ModificationActionType,
} from '@procur/db';

export const MODIFICATION_ACTION_LABEL: Record<ModificationActionType, string> = {
  admin: 'Administrative',
  funding: 'Funding',
  scope: 'Scope',
  period_of_performance: 'Period of performance',
  price: 'Price',
  novation: 'Novation',
  termination: 'Termination',
  other: 'Other',
};

export const CLIN_TYPE_LABEL: Record<ClinType, string> = {
  fixed_price: 'Firm fixed price',
  cost_plus: 'Cost plus',
  time_and_materials: 'Time & materials',
  labor_hour: 'Labor hour',
  other: 'Other',
};

export async function listModificationsForContract(
  contractId: string,
): Promise<ContractModification[]> {
  return db
    .select()
    .from(contractModifications)
    .where(eq(contractModifications.contractId, contractId))
    .orderBy(
      asc(contractModifications.sortOrder),
      asc(contractModifications.actionDate),
      asc(contractModifications.createdAt),
    );
}

export async function listClinsForContract(contractId: string): Promise<ContractClin[]> {
  return db
    .select()
    .from(contractClins)
    .where(eq(contractClins.contractId, contractId))
    .orderBy(asc(contractClins.sortOrder), asc(contractClins.clinNumber));
}

export async function listTaskAreasForContract(
  contractId: string,
): Promise<ContractTaskArea[]> {
  return db
    .select()
    .from(contractTaskAreas)
    .where(eq(contractTaskAreas.contractId, contractId))
    .orderBy(asc(contractTaskAreas.sortOrder), asc(contractTaskAreas.createdAt));
}

export type ModificationsSummary = {
  total: number;
  totalFundingChange: number;
};

export function summarizeModifications(rows: ContractModification[]): ModificationsSummary {
  let total = 0;
  for (const r of rows) {
    if (r.fundingChange != null) total += Number(r.fundingChange);
  }
  return { total: rows.length, totalFundingChange: total };
}

export type ClinsSummary = {
  total: number;
  totalAmount: number;
};

export function summarizeClins(rows: ContractClin[]): ClinsSummary {
  let total = 0;
  for (const r of rows) {
    if (r.amount != null) total += Number(r.amount);
    else if (r.unitPrice != null && r.quantity != null) {
      total += Number(r.unitPrice) * Number(r.quantity);
    }
  }
  return { total: rows.length, totalAmount: total };
}
