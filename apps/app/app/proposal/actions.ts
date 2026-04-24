'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  db,
  opportunities,
  proposals,
  pursuits,
  type NewProposal,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { randomUUID } from 'node:crypto';

type ExtractedRequirement = {
  id: string;
  type: 'technical' | 'financial' | 'legal' | 'compliance' | 'experience';
  text: string;
  mandatory: boolean;
  sourceSection: string;
};

type EvaluationCriterion = {
  name: string;
  weight: number;
  description: string;
};

type OutlineSection = {
  id: string;
  number: string;
  title: string;
  description: string;
  evaluationCriteria: string[];
  pageLimit?: number;
  mandatoryContent: string[];
};

type ComplianceRow = {
  requirementId: string;
  requirementText: string;
  sourceSection: string;
  addressedInSection?: string;
  status: 'not_addressed' | 'partially_addressed' | 'fully_addressed' | 'confirmed';
  confidence: number;
  notes?: string;
};

type SectionDraft = {
  id: string;
  outlineId: string;
  title: string;
  content: string;
  status: 'empty' | 'ai_drafted' | 'in_review' | 'finalized';
  assignedUserId?: string;
  wordCount: number;
  lastEditedAt: string;
};

/**
 * Build a starting outline from extracted requirements by grouping by type.
 * This is a deterministic baseline — Day 2+ will add AI-generated outlines
 * tailored to the specific jurisdiction + tender structure.
 */
function deriveInitialOutline(
  requirements: ExtractedRequirement[],
  criteria: EvaluationCriterion[],
): OutlineSection[] {
  const mkId = () => randomUUID();

  const sections: OutlineSection[] = [
    {
      id: mkId(),
      number: '1',
      title: 'Executive Summary',
      description: 'High-level win themes, company fit, and commitment to the buyer.',
      evaluationCriteria: [],
      mandatoryContent: ['Win themes', 'Company overview', 'Commitment statement'],
    },
    {
      id: mkId(),
      number: '2',
      title: 'Technical Approach',
      description: 'How we will deliver against the technical requirements.',
      evaluationCriteria: criteria
        .filter((c) => /technical|approach|method/i.test(c.name))
        .map((c) => c.name),
      mandatoryContent: requirements
        .filter((r) => r.type === 'technical' && r.mandatory)
        .map((r) => r.text)
        .slice(0, 12),
    },
    {
      id: mkId(),
      number: '3',
      title: 'Past Performance',
      description: 'Relevant prior contracts demonstrating capacity to deliver.',
      evaluationCriteria: criteria
        .filter((c) => /experience|past|performance|reference/i.test(c.name))
        .map((c) => c.name),
      mandatoryContent: requirements
        .filter((r) => r.type === 'experience')
        .map((r) => r.text)
        .slice(0, 8),
    },
    {
      id: mkId(),
      number: '4',
      title: 'Management Plan',
      description: 'Team, governance, and compliance with legal and regulatory requirements.',
      evaluationCriteria: criteria
        .filter((c) => /management|team|governance|quality/i.test(c.name))
        .map((c) => c.name),
      mandatoryContent: requirements
        .filter((r) => r.type === 'legal' || r.type === 'compliance')
        .map((r) => r.text)
        .slice(0, 10),
    },
    {
      id: mkId(),
      number: '5',
      title: 'Pricing',
      description: 'Firm fixed price, labor rates, or schedule of values per solicitation.',
      evaluationCriteria: criteria
        .filter((c) => /price|cost|value/i.test(c.name))
        .map((c) => c.name),
      mandatoryContent: requirements
        .filter((r) => r.type === 'financial')
        .map((r) => r.text)
        .slice(0, 8),
    },
  ];

  return sections;
}

function deriveInitialCompliance(
  requirements: ExtractedRequirement[],
  outline: OutlineSection[],
): ComplianceRow[] {
  // Best-guess assignment by requirement type → likely section.
  const sectionByType: Record<ExtractedRequirement['type'], string | undefined> = {
    technical: outline.find((s) => s.title === 'Technical Approach')?.id,
    experience: outline.find((s) => s.title === 'Past Performance')?.id,
    legal: outline.find((s) => s.title === 'Management Plan')?.id,
    compliance: outline.find((s) => s.title === 'Management Plan')?.id,
    financial: outline.find((s) => s.title === 'Pricing')?.id,
  };
  return requirements.map((r) => ({
    requirementId: r.id,
    requirementText: r.text,
    sourceSection: r.sourceSection,
    addressedInSection: sectionByType[r.type],
    status: 'not_addressed' as const,
    confidence: 0.5,
  }));
}

function deriveInitialSections(outline: OutlineSection[]): SectionDraft[] {
  return outline.map((s) => ({
    id: randomUUID(),
    outlineId: s.id,
    title: s.title,
    content: '',
    status: 'empty' as const,
    wordCount: 0,
    lastEditedAt: new Date().toISOString(),
  }));
}

export async function createProposalAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  if (!pursuitId) throw new Error('pursuitId required');

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
  });
  if (!pursuit) throw new Error('pursuit not found');

  const existing = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (existing) {
    redirect(`/proposal/${pursuitId}`);
  }

  const opp = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, pursuit.opportunityId),
    columns: { extractedRequirements: true, extractedCriteria: true },
  });

  const requirements =
    (opp?.extractedRequirements as ExtractedRequirement[] | null) ?? [];
  const criteria = (opp?.extractedCriteria as EvaluationCriterion[] | null) ?? [];

  const outline = deriveInitialOutline(requirements, criteria);
  const compliance = deriveInitialCompliance(requirements, outline);
  const sections = deriveInitialSections(outline);

  const row: NewProposal = {
    pursuitId,
    status: 'drafting',
    outline,
    complianceMatrix: compliance,
    sections,
  };
  await db.insert(proposals).values(row);

  revalidatePath('/proposal');
  revalidatePath(`/proposal/${pursuitId}`);
  redirect(`/proposal/${pursuitId}`);
}

export async function updateComplianceMappingAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const requirementId = String(formData.get('requirementId') ?? '');
  const addressedInSection = String(formData.get('addressedInSection') ?? '') || undefined;
  const status = String(formData.get('status') ?? '') as ComplianceRow['status'];
  if (!pursuitId || !requirementId) throw new Error('missing args');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');

  // Ownership check
  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('not authorized');

  const current = (proposal.complianceMatrix as ComplianceRow[] | null) ?? [];
  const updated = current.map((c) =>
    c.requirementId === requirementId
      ? {
          ...c,
          addressedInSection,
          status:
            ['not_addressed', 'partially_addressed', 'fully_addressed', 'confirmed'].includes(
              status,
            )
              ? status
              : c.status,
        }
      : c,
  );

  await db
    .update(proposals)
    .set({ complianceMatrix: updated, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function updateSectionAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const status = String(formData.get('status') ?? '') as SectionDraft['status'];

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');
  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('not authorized');

  const sections = (proposal.sections as SectionDraft[] | null) ?? [];
  const nextSections = sections.map((s) =>
    s.id === sectionId
      ? {
          ...s,
          title: title || s.title,
          status: ['empty', 'ai_drafted', 'in_review', 'finalized'].includes(status)
            ? status
            : s.status,
          lastEditedAt: new Date().toISOString(),
        }
      : s,
  );

  const outline =
    (proposal.outline as OutlineSection[] | null)?.map((o) => {
      const match = nextSections.find((s) => s.outlineId === o.id);
      return match && title && match.id === sectionId ? { ...o, title } : o;
    }) ?? [];

  await db
    .update(proposals)
    .set({ sections: nextSections, outline, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}
