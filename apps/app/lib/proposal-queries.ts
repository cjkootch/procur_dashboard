import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  proposals,
  pursuits,
  type Proposal,
} from '@procur/db';

export type ProposalListRow = {
  pursuitId: string;
  opportunityId: string;
  opportunityTitle: string;
  jurisdictionName: string;
  jurisdictionCountry: string;
  agencyName: string | null;
  deadlineAt: Date | null;
  proposalId: string | null;
  status: Proposal['status'] | null;
  sectionsCount: number;
  complianceAddressedCount: number;
  complianceTotalCount: number;
  updatedAt: Date;
};

export async function listCompanyProposals(companyId: string): Promise<ProposalListRow[]> {
  const rows = await db
    .select({
      pursuitId: pursuits.id,
      opportunityId: opportunities.id,
      opportunityTitle: opportunities.title,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      deadlineAt: opportunities.deadlineAt,
      stage: pursuits.stage,
      proposalId: proposals.id,
      status: proposals.status,
      outline: proposals.outline,
      complianceMatrix: proposals.complianceMatrix,
      updatedAt: proposals.updatedAt,
      pursuitUpdatedAt: pursuits.updatedAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .leftJoin(proposals, eq(proposals.pursuitId, pursuits.id))
    .where(
      and(
        eq(pursuits.companyId, companyId),
        inArray(pursuits.stage, ['proposal_development', 'submitted', 'awarded', 'lost']),
      ),
    )
    .orderBy(desc(pursuits.updatedAt));

  return rows.map((r) => {
    const outline = (r.outline as Array<{ id: string }> | null) ?? [];
    const compliance = (r.complianceMatrix as Array<{ status: string }> | null) ?? [];
    const addressed = compliance.filter(
      (c) => c.status === 'fully_addressed' || c.status === 'confirmed',
    ).length;
    return {
      pursuitId: r.pursuitId,
      opportunityId: r.opportunityId,
      opportunityTitle: r.opportunityTitle,
      jurisdictionName: r.jurisdictionName,
      jurisdictionCountry: r.jurisdictionCountry,
      agencyName: r.agencyName,
      deadlineAt: r.deadlineAt,
      proposalId: r.proposalId,
      status: r.status,
      sectionsCount: outline.length,
      complianceAddressedCount: addressed,
      complianceTotalCount: compliance.length,
      updatedAt: r.updatedAt ?? r.pursuitUpdatedAt,
    };
  });
}

export type ProposalDetail = {
  proposal: Proposal | null;
  pursuit: {
    id: string;
    companyId: string;
    stage: string;
  };
  opportunity: {
    id: string;
    title: string;
    description: string | null;
    referenceNumber: string | null;
    deadlineAt: Date | null;
    jurisdictionName: string;
    jurisdictionCountry: string;
    agencyName: string | null;
    extractedRequirements: unknown;
    extractedCriteria: unknown;
    mandatoryDocuments: unknown;
  };
};

export async function getProposalByPursuitId(
  companyId: string,
  pursuitId: string,
): Promise<ProposalDetail | null> {
  const [row] = await db
    .select({
      pursuitId: pursuits.id,
      pursuitCompanyId: pursuits.companyId,
      pursuitStage: pursuits.stage,
      oppId: opportunities.id,
      oppTitle: opportunities.title,
      oppDescription: opportunities.description,
      oppReferenceNumber: opportunities.referenceNumber,
      oppDeadlineAt: opportunities.deadlineAt,
      jurisdictionName: jurisdictions.name,
      jurisdictionCountry: jurisdictions.countryCode,
      agencyName: agencies.name,
      oppExtractedRequirements: opportunities.extractedRequirements,
      oppExtractedCriteria: opportunities.extractedCriteria,
      oppMandatoryDocuments: opportunities.mandatoryDocuments,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)))
    .limit(1);

  if (!row) return null;

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });

  return {
    proposal: proposal ?? null,
    pursuit: {
      id: row.pursuitId,
      companyId: row.pursuitCompanyId,
      stage: row.pursuitStage,
    },
    opportunity: {
      id: row.oppId,
      title: row.oppTitle,
      description: row.oppDescription,
      referenceNumber: row.oppReferenceNumber,
      deadlineAt: row.oppDeadlineAt,
      jurisdictionName: row.jurisdictionName,
      jurisdictionCountry: row.jurisdictionCountry,
      agencyName: row.agencyName,
      extractedRequirements: row.oppExtractedRequirements,
      extractedCriteria: row.oppExtractedCriteria,
      mandatoryDocuments: row.oppMandatoryDocuments,
    },
  };
}
