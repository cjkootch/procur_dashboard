import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  agencies,
  contracts,
  db,
  jurisdictions,
  opportunities,
  pursuits,
  type Contract,
} from '@procur/db';

export type ContractListRow = {
  id: string;
  awardTitle: string;
  awardingAgency: string | null;
  tier: string;
  status: string;
  contractNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  totalValue: string | null;
  currency: string | null;
  totalValueUsd: string | null;
  obligationCount: number;
  openObligationCount: number;
  updatedAt: Date;
};

export async function listContracts(companyId: string): Promise<ContractListRow[]> {
  const rows = await db
    .select()
    .from(contracts)
    .where(eq(contracts.companyId, companyId))
    .orderBy(desc(contracts.updatedAt));

  return rows.map((c) => {
    const obls = c.obligations ?? [];
    const open = obls.filter((o) => o.status !== 'completed').length;
    return {
      id: c.id,
      awardTitle: c.awardTitle,
      awardingAgency: c.awardingAgency,
      tier: c.tier,
      status: c.status,
      contractNumber: c.contractNumber,
      startDate: c.startDate,
      endDate: c.endDate,
      totalValue: c.totalValue,
      currency: c.currency,
      totalValueUsd: c.totalValueUsd,
      obligationCount: obls.length,
      openObligationCount: open,
      updatedAt: c.updatedAt,
    };
  });
}

export async function getContractById(
  companyId: string,
  contractId: string,
): Promise<Contract | null> {
  const row = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)),
  });
  return row ?? null;
}

export type AwardableCapture = {
  pursuitId: string;
  opportunityId: string;
  opportunityTitle: string;
  agencyName: string | null;
  jurisdictionName: string;
  deadlineAt: Date | null;
  valueEstimate: string | null;
  currency: string | null;
  existingContractId: string | null;
};

/**
 * Awarded pursuits that could be turned into a contract. Excludes those that
 * already have a linked contract.
 */
export async function listAwardableCaptures(companyId: string): Promise<AwardableCapture[]> {
  const rows = await db
    .select({
      pursuitId: pursuits.id,
      opportunityId: opportunities.id,
      opportunityTitle: opportunities.title,
      agencyName: agencies.name,
      jurisdictionName: jurisdictions.name,
      deadlineAt: opportunities.deadlineAt,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.companyId, companyId), eq(pursuits.stage, 'awarded')));

  if (rows.length === 0) return [];

  const existing = await db
    .select({ pursuitId: contracts.pursuitId, id: contracts.id })
    .from(contracts)
    .where(eq(contracts.companyId, companyId));
  const byPursuit = new Map<string, string>();
  for (const e of existing) if (e.pursuitId) byPursuit.set(e.pursuitId, e.id);

  return rows.map((r) => ({
    pursuitId: r.pursuitId,
    opportunityId: r.opportunityId,
    opportunityTitle: r.opportunityTitle,
    agencyName: r.agencyName,
    jurisdictionName: r.jurisdictionName,
    deadlineAt: r.deadlineAt,
    valueEstimate: r.valueEstimate,
    currency: r.currency,
    existingContractId: byPursuit.get(r.pursuitId) ?? null,
  }));
}
