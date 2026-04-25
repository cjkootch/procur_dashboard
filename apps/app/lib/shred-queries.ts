import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import {
  db,
  proposals,
  proposalShreds,
  pursuits,
  type ProposalShred,
  type ShredType,
} from '@procur/db';

export const SHRED_TYPE_LABEL: Record<ShredType, string> = {
  shall: 'Shall',
  will: 'Will',
  must: 'Must',
  should: 'Should',
  may: 'May',
  none: 'None',
};

/** Mandatory verbs — used to count compliance obligations. */
export const MANDATORY_TYPES: ShredType[] = ['shall', 'will', 'must'];

/**
 * Ownership-checked load of (pursuit, proposal) by pursuitId. Returns
 * null if the pursuit doesn't belong to the company OR no proposal
 * exists yet — callers should send the user to /proposal/[pursuitId]
 * to start one in either case.
 */
export async function getOwnedProposalForPursuit(
  companyId: string,
  pursuitId: string,
): Promise<{ id: string; pursuitId: string } | null> {
  const rows = await db
    .select({ id: proposals.id, pursuitId: proposals.pursuitId })
    .from(proposals)
    .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
    .where(and(eq(proposals.pursuitId, pursuitId), eq(pursuits.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listShredsForProposal(proposalId: string): Promise<ProposalShred[]> {
  return db
    .select()
    .from(proposalShreds)
    .where(eq(proposalShreds.proposalId, proposalId))
    .orderBy(asc(proposalShreds.sortOrder), asc(proposalShreds.createdAt));
}

export type ShredSummary = {
  total: number;
  mandatoryTotal: number;
  mandatoryAccounted: number;
  byType: Record<ShredType, number>;
  sectionsCount: number;
};

export function summarizeShreds(rows: ProposalShred[]): ShredSummary {
  const byType: Record<ShredType, number> = {
    shall: 0,
    will: 0,
    must: 0,
    should: 0,
    may: 0,
    none: 0,
  };
  const sections = new Set<string>();
  let mandatory = 0;
  let accounted = 0;
  for (const r of rows) {
    byType[r.shredType] += 1;
    if (r.sectionPath) sections.add(r.sectionPath);
    if (MANDATORY_TYPES.includes(r.shredType)) {
      mandatory += 1;
      if (r.accountedFor) accounted += 1;
    }
  }
  return {
    total: rows.length,
    mandatoryTotal: mandatory,
    mandatoryAccounted: accounted,
    byType,
    sectionsCount: sections.size,
  };
}

/**
 * Group shreds by sectionPath in document order (preserving sortOrder
 * within each section, and ordering sections by their first-seen
 * sortOrder so they render in RFP order).
 */
export function groupShredsBySection(
  rows: ProposalShred[],
): Array<{ sectionPath: string; sectionTitle: string | null; shreds: ProposalShred[] }> {
  const groups = new Map<string, { sectionTitle: string | null; shreds: ProposalShred[] }>();
  for (const r of rows) {
    const key = r.sectionPath || '— No section —';
    const existing = groups.get(key);
    if (existing) {
      existing.shreds.push(r);
      if (!existing.sectionTitle && r.sectionTitle) existing.sectionTitle = r.sectionTitle;
    } else {
      groups.set(key, { sectionTitle: r.sectionTitle, shreds: [r] });
    }
  }
  return Array.from(groups.entries()).map(([sectionPath, v]) => ({
    sectionPath,
    sectionTitle: v.sectionTitle,
    shreds: v.shreds,
  }));
}
