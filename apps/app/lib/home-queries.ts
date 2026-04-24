import 'server-only';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
  agencies,
  contracts,
  db,
  jurisdictions,
  opportunities,
  proposals,
  pursuits,
} from '@procur/db';

export type DeadlinePursuit = {
  pursuitId: string;
  opportunityTitle: string;
  agencyName: string | null;
  jurisdictionName: string;
  jurisdictionCountry: string;
  deadlineAt: Date;
  stage: string;
  pWin: number | null;
};

export type DraftingProposal = {
  pursuitId: string;
  opportunityTitle: string;
  deadlineAt: Date | null;
  status: string;
  unaddressedRequirements: number;
  totalRequirements: number;
};

export type UpcomingObligation = {
  contractId: string;
  contractTitle: string;
  description: string;
  dueDate: string;
  status: string;
};

export type HomeData = {
  totalPursuits: number;
  openPursuits: number;
  activeContracts: number;
  submittedProposals: number;
  upcomingDeadlines: DeadlinePursuit[];
  draftingProposals: DraftingProposal[];
  upcomingObligations: UpcomingObligation[];
};

type ComplianceRow = {
  status: string;
};

export async function getHomeData(companyId: string): Promise<HomeData> {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [totals, openCounts, deadlineRows, draftingRows, contractRows] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(pursuits)
      .where(eq(pursuits.companyId, companyId)),

    db
      .select({ stage: pursuits.stage, n: sql<number>`count(*)::int` })
      .from(pursuits)
      .where(eq(pursuits.companyId, companyId))
      .groupBy(pursuits.stage),

    db
      .select({
        pursuitId: pursuits.id,
        opportunityTitle: opportunities.title,
        agencyName: agencies.name,
        jurisdictionName: jurisdictions.name,
        jurisdictionCountry: jurisdictions.countryCode,
        deadlineAt: opportunities.deadlineAt,
        stage: pursuits.stage,
        pWin: pursuits.pWin,
      })
      .from(pursuits)
      .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
      .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
      .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
      .where(
        and(
          eq(pursuits.companyId, companyId),
          isNotNull(opportunities.deadlineAt),
          gt(opportunities.deadlineAt, now),
          lte(opportunities.deadlineAt, in30),
          inArray(pursuits.stage, [
            'qualification',
            'capture_planning',
            'proposal_development',
            'submitted',
          ]),
        ),
      )
      .orderBy(asc(opportunities.deadlineAt))
      .limit(6),

    db
      .select({
        pursuitId: pursuits.id,
        opportunityTitle: opportunities.title,
        deadlineAt: opportunities.deadlineAt,
        status: proposals.status,
        complianceMatrix: proposals.complianceMatrix,
      })
      .from(proposals)
      .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
      .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
      .where(
        and(
          eq(pursuits.companyId, companyId),
          ne(proposals.status, 'submitted'),
        ),
      )
      .orderBy(desc(proposals.updatedAt))
      .limit(5),

    db
      .select({
        id: contracts.id,
        awardTitle: contracts.awardTitle,
        status: contracts.status,
        obligations: contracts.obligations,
      })
      .from(contracts)
      .where(eq(contracts.companyId, companyId)),
  ]);

  const totalPursuits = totals[0]?.n ?? 0;
  const closedStages = new Set(['awarded', 'lost']);
  const openPursuits = openCounts
    .filter((r) => !closedStages.has(r.stage))
    .reduce((sum, r) => sum + r.n, 0);
  const submittedProposals = openCounts.find((r) => r.stage === 'submitted')?.n ?? 0;
  const activeContracts = contractRows.filter((c) => c.status === 'active').length;

  const upcomingDeadlines = deadlineRows
    .filter((r): r is typeof r & { deadlineAt: Date } => r.deadlineAt !== null)
    .map((r) => ({
      pursuitId: r.pursuitId,
      opportunityTitle: r.opportunityTitle,
      agencyName: r.agencyName,
      jurisdictionName: r.jurisdictionName,
      jurisdictionCountry: r.jurisdictionCountry,
      deadlineAt: r.deadlineAt,
      stage: r.stage,
      pWin: r.pWin ? Number.parseFloat(r.pWin) : null,
    }));

  const draftingProposals: DraftingProposal[] = draftingRows.map((r) => {
    const compliance = (r.complianceMatrix as ComplianceRow[] | null) ?? [];
    const unaddressed = compliance.filter(
      (c) => c.status === 'not_addressed' || c.status === 'partially_addressed',
    ).length;
    return {
      pursuitId: r.pursuitId,
      opportunityTitle: r.opportunityTitle,
      deadlineAt: r.deadlineAt,
      status: r.status,
      unaddressedRequirements: unaddressed,
      totalRequirements: compliance.length,
    };
  });

  const todayIso = now.toISOString().slice(0, 10);
  const in30Iso = in30.toISOString().slice(0, 10);
  const upcomingObligations: UpcomingObligation[] = [];
  for (const c of contractRows) {
    const obls = c.obligations ?? [];
    for (const o of obls) {
      if (
        o.dueDate &&
        o.status !== 'completed' &&
        o.dueDate >= todayIso &&
        o.dueDate <= in30Iso
      ) {
        upcomingObligations.push({
          contractId: c.id,
          contractTitle: c.awardTitle,
          description: o.description,
          dueDate: o.dueDate,
          status: o.status,
        });
      }
    }
  }
  upcomingObligations.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    totalPursuits,
    openPursuits,
    activeContracts,
    submittedProposals,
    upcomingDeadlines,
    draftingProposals,
    upcomingObligations: upcomingObligations.slice(0, 6),
  };
}
