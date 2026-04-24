import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import {
  contracts,
  db,
  pastPerformance,
  type PastPerformance,
} from '@procur/db';

export type PastPerformanceListRow = {
  id: string;
  projectName: string;
  customerName: string;
  customerType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalValue: string | null;
  currency: string | null;
  categoryCount: number;
  updatedAt: Date;
};

export async function listPastPerformance(
  companyId: string,
): Promise<PastPerformanceListRow[]> {
  const rows = await db
    .select()
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, companyId))
    .orderBy(desc(pastPerformance.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    customerName: r.customerName,
    customerType: r.customerType,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    totalValue: r.totalValue,
    currency: r.currency,
    categoryCount: (r.categories ?? []).length,
    updatedAt: r.updatedAt,
  }));
}

export async function getPastPerformanceById(
  companyId: string,
  id: string,
): Promise<PastPerformance | null> {
  const row = await db.query.pastPerformance.findFirst({
    where: and(eq(pastPerformance.id, id), eq(pastPerformance.companyId, companyId)),
  });
  return row ?? null;
}

export type ConvertibleContract = {
  id: string;
  awardTitle: string;
  awardingAgency: string | null;
  startDate: string | null;
  endDate: string | null;
  totalValue: string | null;
  currency: string | null;
  status: string;
  hasPastPerformance: boolean;
};

/**
 * Completed or still-active contracts we could convert into a past
 * performance record. Flags any that already have one (matched by
 * project name for now — the schema lacks a direct FK).
 */
export async function listConvertibleContracts(companyId: string): Promise<ConvertibleContract[]> {
  const [cs, pps] = await Promise.all([
    db
      .select({
        id: contracts.id,
        awardTitle: contracts.awardTitle,
        awardingAgency: contracts.awardingAgency,
        startDate: contracts.startDate,
        endDate: contracts.endDate,
        totalValue: contracts.totalValue,
        currency: contracts.currency,
        status: contracts.status,
      })
      .from(contracts)
      .where(eq(contracts.companyId, companyId))
      .orderBy(desc(contracts.updatedAt)),
    db
      .select({ projectName: pastPerformance.projectName })
      .from(pastPerformance)
      .where(eq(pastPerformance.companyId, companyId)),
  ]);

  const existingNames = new Set(pps.map((p) => p.projectName.toLowerCase()));
  return cs.map((c) => ({
    ...c,
    hasPastPerformance: existingNames.has(c.awardTitle.toLowerCase()),
  }));
}
