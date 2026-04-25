import 'server-only';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import {
  aiUsage,
  companies,
  contracts,
  db,
  proposals,
  pursuits,
  users,
  type Company,
} from '@procur/db';

export type TenantListRow = {
  id: string;
  name: string;
  planTier: string;
  country: string | null;
  createdAt: Date;
  userCount: number;
  pursuitCount: number;
  proposalCount: number;
  contractCount: number;
  costCentsThisMonth: number;
};

/**
 * Cross-tenant overview list. Joins are done in JS rather than as one
 * giant SQL because (a) tenant counts are 10s-100s in v1, (b) different
 * counts come from different tables which would need either a CTE per
 * count or denormalized columns. JS aggregation is the right v1
 * trade-off; revisit when there are 1000+ tenants.
 */
export async function listTenants(): Promise<TenantListRow[]> {
  const monthStart = startOfThisMonthIso();

  const [
    companyRows,
    userCounts,
    pursuitCounts,
    proposalCounts,
    contractCounts,
    aiCosts,
  ] = await Promise.all([
    db
      .select()
      .from(companies)
      .orderBy(desc(companies.createdAt)),
    db
      .select({ companyId: users.companyId, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.companyId),
    db
      .select({ companyId: pursuits.companyId, n: sql<number>`count(*)::int` })
      .from(pursuits)
      .groupBy(pursuits.companyId),
    db
      .select({
        companyId: pursuits.companyId,
        n: sql<number>`count(*)::int`,
      })
      .from(proposals)
      .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
      .groupBy(pursuits.companyId),
    db
      .select({
        companyId: contracts.companyId,
        n: sql<number>`count(*)::int`,
      })
      .from(contracts)
      .groupBy(contracts.companyId),
    db
      .select({
        companyId: aiUsage.companyId,
        cents: sql<number>`coalesce(sum(${aiUsage.costUsdCents})::int, 0)`,
      })
      .from(aiUsage)
      .where(gte(aiUsage.date, monthStart))
      .groupBy(aiUsage.companyId),
  ]);

  const usersById = bucket(userCounts);
  const pursuitsById = bucket(pursuitCounts);
  const proposalsById = bucket(proposalCounts);
  const contractsById = bucket(contractCounts);
  const costsById = new Map(aiCosts.map((r) => [r.companyId, r.cents]));

  return companyRows.map((c) => ({
    id: c.id,
    name: c.name,
    planTier: c.planTier,
    country: c.country,
    createdAt: c.createdAt,
    userCount: usersById.get(c.id) ?? 0,
    pursuitCount: pursuitsById.get(c.id) ?? 0,
    proposalCount: proposalsById.get(c.id) ?? 0,
    contractCount: contractsById.get(c.id) ?? 0,
    costCentsThisMonth: costsById.get(c.id) ?? 0,
  }));
}

export type TenantDetail = {
  company: Company;
  members: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    createdAt: Date;
  }>;
  counts: {
    pursuits: number;
    proposals: number;
    contracts: number;
  };
  aiCostsThisMonth: Array<{ source: string; cents: number; calls: number }>;
};

export async function getTenantDetail(companyId: string): Promise<TenantDetail | null> {
  const monthStart = startOfThisMonthIso();
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
  });
  if (!company) return null;

  const [members, pursuitN, proposalN, contractN, costs] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.companyId, companyId))
      .orderBy(asc(users.createdAt)),
    countWhere(pursuits, eq(pursuits.companyId, companyId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(proposals)
      .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
      .where(eq(pursuits.companyId, companyId)),
    countWhere(contracts, eq(contracts.companyId, companyId)),
    db
      .select({
        source: aiUsage.source,
        cents: sql<number>`coalesce(sum(${aiUsage.costUsdCents})::int, 0)`,
        calls: sql<number>`coalesce(sum(${aiUsage.calls})::int, 0)`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.companyId, companyId), gte(aiUsage.date, monthStart)))
      .groupBy(aiUsage.source),
  ]);

  return {
    company,
    members,
    counts: {
      pursuits: pursuitN,
      proposals: proposalN[0]?.n ?? 0,
      contracts: contractN,
    },
    aiCostsThisMonth: costs
      .map((r) => ({ source: r.source, cents: r.cents, calls: r.calls }))
      .sort((a, b) => b.cents - a.cents),
  };
}

export type UsageRow = {
  companyId: string;
  companyName: string;
  cents: number;
  calls: number;
};

/** AI spend by company for the current calendar month, descending. */
export async function listAiSpendThisMonth(): Promise<UsageRow[]> {
  const monthStart = startOfThisMonthIso();
  const rows = await db
    .select({
      companyId: aiUsage.companyId,
      companyName: companies.name,
      cents: sql<number>`coalesce(sum(${aiUsage.costUsdCents})::int, 0)`,
      calls: sql<number>`coalesce(sum(${aiUsage.calls})::int, 0)`,
    })
    .from(aiUsage)
    .innerJoin(companies, eq(companies.id, aiUsage.companyId))
    .where(gte(aiUsage.date, monthStart))
    .groupBy(aiUsage.companyId, companies.name);
  return rows.sort((a, b) => b.cents - a.cents);
}

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

function bucket(rows: Array<{ companyId: string | null; n: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.companyId) m.set(r.companyId, r.n);
  }
  return m;
}

async function countWhere(
  table: typeof pursuits | typeof contracts,
  whereExpr: ReturnType<typeof eq>,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(whereExpr);
  return row?.n ?? 0;
}

/** YYYY-MM-01 in UTC. ai_usage.date is a date column so we compare as date. */
function startOfThisMonthIso(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
