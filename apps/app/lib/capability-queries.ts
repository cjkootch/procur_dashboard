import 'server-only';
import { asc, eq } from 'drizzle-orm';
import {
  companyCapabilities,
  db,
  pursuitCapabilityRequirements,
  type CapabilityCategory,
  type CompanyCapability,
  type CoverageStatus,
  type PursuitCapabilityRequirement,
  type RequirementPriority,
} from '@procur/db';

export const CAPABILITY_CATEGORY_LABEL: Record<CapabilityCategory, string> = {
  service: 'Service',
  certification: 'Certification',
  technology: 'Technology',
  geography: 'Geography',
  personnel: 'Personnel',
  past_performance: 'Past performance',
  other: 'Other',
};

export const REQUIREMENT_PRIORITY_LABEL: Record<RequirementPriority, string> = {
  must: 'Must-have',
  should: 'Should-have',
  nice: 'Nice-to-have',
};

export const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  not_assessed: 'Not assessed',
  covered: 'Covered',
  partial: 'Partial',
  gap: 'Gap',
};

export async function listCompanyCapabilities(
  companyId: string,
): Promise<CompanyCapability[]> {
  return db
    .select()
    .from(companyCapabilities)
    .where(eq(companyCapabilities.companyId, companyId))
    .orderBy(asc(companyCapabilities.category), asc(companyCapabilities.name));
}

export type RequirementRow = PursuitCapabilityRequirement & {
  capabilityName: string | null;
  capabilityCategory: CapabilityCategory | null;
};

export async function listRequirementsForPursuit(
  pursuitId: string,
): Promise<RequirementRow[]> {
  const rows = await db
    .select({
      req: pursuitCapabilityRequirements,
      capabilityName: companyCapabilities.name,
      capabilityCategory: companyCapabilities.category,
    })
    .from(pursuitCapabilityRequirements)
    .leftJoin(
      companyCapabilities,
      eq(companyCapabilities.id, pursuitCapabilityRequirements.capabilityId),
    )
    .where(eq(pursuitCapabilityRequirements.pursuitId, pursuitId))
    .orderBy(
      asc(pursuitCapabilityRequirements.sortOrder),
      asc(pursuitCapabilityRequirements.createdAt),
    );

  return rows.map((r) => ({
    ...r.req,
    capabilityName: r.capabilityName,
    capabilityCategory: r.capabilityCategory,
  }));
}

export type CapabilitySummary = {
  total: number;
  covered: number;
  partial: number;
  gap: number;
  notAssessed: number;
  mustGapCount: number;
};

export function summarizeRequirements(rows: RequirementRow[]): CapabilitySummary {
  let covered = 0,
    partial = 0,
    gap = 0,
    notAssessed = 0,
    mustGap = 0;
  for (const r of rows) {
    if (r.coverage === 'covered') covered += 1;
    else if (r.coverage === 'partial') partial += 1;
    else if (r.coverage === 'gap') gap += 1;
    else notAssessed += 1;
    if (r.priority === 'must' && r.coverage === 'gap') mustGap += 1;
  }
  return {
    total: rows.length,
    covered,
    partial,
    gap,
    notAssessed,
    mustGapCount: mustGap,
  };
}
