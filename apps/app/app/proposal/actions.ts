'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  proposals,
  pursuits,
  type NewProposal,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { draftSection, embedText, mapRequirementsToSections, reviewProposal } from '@procur/ai';
import { randomUUID } from 'node:crypto';
import { semanticSearchLibrary } from '../../lib/library-queries';
import { semanticSearchPastPerformance } from '../../lib/past-performance-queries';
import {
  getTemplateById,
  GENERIC_TEMPLATE,
  type ProposalTemplate,
} from '../../lib/proposal-templates';

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
function keywordMatch(haystack: string, keywords: RegExp): boolean {
  return keywords.test(haystack);
}

/**
 * Match requirements + criteria into a template's sections by section title
 * keyword. Templates own the structure; we just decorate with the content
 * AI extracted from the tender.
 */
function deriveOutlineFromTemplate(
  template: ProposalTemplate,
  requirements: ExtractedRequirement[],
  criteria: EvaluationCriterion[],
): OutlineSection[] {
  const mkId = () => randomUUID();

  const typeMap: Array<{ re: RegExp; types: ExtractedRequirement['type'][] }> = [
    { re: /technical|approach|method|scope/i, types: ['technical'] },
    { re: /experience|past|performance|reference/i, types: ['experience'] },
    { re: /management|team|governance|personnel/i, types: [] },
    { re: /compliance|eligibilit|credent|legal|qualifi/i, types: ['legal', 'compliance'] },
    { re: /price|cost|financ|bill|schedule|economic|propuesta económica/i, types: ['financial'] },
  ];

  return template.sections.map((s) => {
    const matched = typeMap.find((m) => m.re.test(s.title));
    const matchedRequirements = matched
      ? requirements.filter((r) => matched.types.includes(r.type) && r.mandatory)
      : [];
    const matchedCriteria = criteria.filter((c) => keywordMatch(c.name, new RegExp(s.title.split(' ')[0] ?? '', 'i'))).map((c) => c.name);

    const mandatoryContent = [
      ...s.mandatoryContent,
      ...matchedRequirements.map((r) => r.text).slice(0, 12 - s.mandatoryContent.length),
    ];

    return {
      id: mkId(),
      number: s.number,
      title: s.title,
      description: s.description,
      evaluationCriteria: matchedCriteria,
      pageLimit: s.pageLimit,
      mandatoryContent,
    };
  });
}

function deriveInitialCompliance(
  requirements: ExtractedRequirement[],
  outline: OutlineSection[],
): ComplianceRow[] {
  // Best-guess assignment by requirement type → likely section in the outline.
  const findByKeyword = (re: RegExp) => outline.find((s) => re.test(s.title))?.id;
  const sectionByType: Record<ExtractedRequirement['type'], string | undefined> = {
    technical: findByKeyword(/technical|approach|scope/i),
    experience: findByKeyword(/experience|past|performance/i),
    legal: findByKeyword(/compliance|eligibilit|credent|legal|qualifi|corporate/i),
    compliance: findByKeyword(/compliance|eligibilit|credent|legal|qualifi|corporate/i),
    financial: findByKeyword(/price|cost|financ|bill|schedule|economic|propuesta económica/i),
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
  const templateId = String(formData.get('templateId') ?? 'generic');
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

  const template = getTemplateById(templateId) ?? GENERIC_TEMPLATE;
  const outline = deriveOutlineFromTemplate(template, requirements, criteria);
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

export async function draftSectionAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const sectionId = String(formData.get('sectionId') ?? '');
  const userInstruction = String(formData.get('instruction') ?? '').trim();

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true, opportunityId: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');

  const sectionsArr = (proposal.sections as SectionDraft[] | null) ?? [];
  const outlineArr = (proposal.outline as OutlineSection[] | null) ?? [];
  const section = sectionsArr.find((s) => s.id === sectionId);
  const outlineEntry = outlineArr.find((o) => o.id === section?.outlineId);
  if (!section || !outlineEntry) throw new Error('section not found');

  const [oppRow] = await db
    .select({
      title: opportunities.title,
      description: opportunities.description,
      referenceNumber: opportunities.referenceNumber,
      agencyName: agencies.name,
      jurisdictionName: jurisdictions.name,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(opportunities.id, pursuit.opportunityId))
    .limit(1);
  if (!oppRow) throw new Error('opportunity not found');

  // Build retrieval query from section context + any existing content guidance
  const retrievalQuery = [
    outlineEntry.title,
    outlineEntry.description,
    ...outlineEntry.mandatoryContent.slice(0, 5),
    ...outlineEntry.evaluationCriteria,
    userInstruction,
  ]
    .filter(Boolean)
    .join('\n');

  let libraryExcerpts: Array<{ title: string; type: string; content: string }> = [];
  try {
    const queryEmb = await embedText(retrievalQuery);
    const [libHits, ppHits] = await Promise.all([
      semanticSearchLibrary(company.id, queryEmb, 5),
      semanticSearchPastPerformance(company.id, queryEmb, 3),
    ]);
    libraryExcerpts = [
      ...libHits.map((h) => ({ title: h.title, type: h.type, content: h.content })),
      ...ppHits.map((p) => ({
        title: `${p.projectName} — ${p.customerName}`,
        type: 'past_performance',
        content: [
          p.scopeDescription,
          (p.keyAccomplishments ?? []).length > 0
            ? `Accomplishments: ${(p.keyAccomplishments ?? []).join('; ')}`
            : null,
          p.outcomes ? `Outcomes: ${p.outcomes}` : null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      })),
    ];
  } catch (err) {
    // If embeddings aren't set up yet (no OPENAI_API_KEY), proceed without retrieval.
    console.warn('library retrieval skipped:', err);
  }

  const result = await draftSection({
    opportunity: {
      title: oppRow.title,
      agency: oppRow.agencyName,
      jurisdiction: oppRow.jurisdictionName,
      referenceNumber: oppRow.referenceNumber,
      description: oppRow.description,
    },
    company: {
      name: company.name,
      country: company.country,
      capabilities: company.capabilities ?? undefined,
    },
    section: {
      number: outlineEntry.number,
      title: outlineEntry.title,
      description: outlineEntry.description,
      evaluationCriteria: outlineEntry.evaluationCriteria,
      mandatoryContent: outlineEntry.mandatoryContent,
      pageLimit: outlineEntry.pageLimit,
    },
    libraryExcerpts,
    existingContent: section.content || undefined,
    userInstruction: userInstruction || undefined,
  });

  const nextSections = sectionsArr.map((s) =>
    s.id === sectionId
      ? {
          ...s,
          content: result.content,
          status: 'ai_drafted' as const,
          wordCount: result.wordCount,
          lastEditedAt: new Date().toISOString(),
        }
      : s,
  );

  await db
    .update(proposals)
    .set({ sections: nextSections, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

/**
 * Re-runs the compliance matrix by asking Sonnet to map every extracted
 * requirement to the drafted section that addresses it, with confidence and
 * a one-sentence note. User-confirmed rows are preserved.
 */
export async function regenerateComplianceAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true, opportunityId: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');

  const opp = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, pursuit.opportunityId),
    columns: { extractedRequirements: true },
  });
  const requirements =
    (opp?.extractedRequirements as ExtractedRequirement[] | null) ?? [];
  if (requirements.length === 0) throw new Error('no extracted requirements to map');

  const outline = (proposal.outline as OutlineSection[] | null) ?? [];
  const sections = (proposal.sections as SectionDraft[] | null) ?? [];
  const sectionInput = outline.map((o) => {
    const draft = sections.find((s) => s.outlineId === o.id);
    return {
      id: o.id,
      number: o.number,
      title: o.title,
      content: draft?.content ?? '',
    };
  });

  const result = await mapRequirementsToSections({
    requirements: requirements.map((r) => ({
      id: r.id,
      text: r.text,
      type: r.type,
      mandatory: r.mandatory,
    })),
    sections: sectionInput,
  });

  const existing = (proposal.complianceMatrix as ComplianceRow[] | null) ?? [];
  const confirmedByReqId = new Map(
    existing.filter((r) => r.status === 'confirmed').map((r) => [r.requirementId, r]),
  );
  const sourceByReqId = new Map(requirements.map((r) => [r.id, r.sourceSection]));

  const updated: ComplianceRow[] = result.mappings.map((m) => {
    const confirmed = confirmedByReqId.get(m.requirementId);
    if (confirmed) return confirmed;
    const req = requirements.find((r) => r.id === m.requirementId);
    return {
      requirementId: m.requirementId,
      requirementText: req?.text ?? '',
      sourceSection: sourceByReqId.get(m.requirementId) ?? '',
      addressedInSection: m.addressedInSection ?? undefined,
      status: m.status,
      confidence: m.confidence,
      notes: m.notes,
    };
  });

  await db
    .update(proposals)
    .set({ complianceMatrix: updated, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

/**
 * Runs a final AI review of the full proposal. Persists an aiReview blob with
 * overall score, verdict, strengths, risks, and per-section feedback.
 */
export async function reviewProposalAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true, opportunityId: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');

  const [oppRow] = await db
    .select({
      title: opportunities.title,
      description: opportunities.description,
      agencyName: agencies.name,
      jurisdictionName: jurisdictions.name,
    })
    .from(opportunities)
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(opportunities.id, pursuit.opportunityId))
    .limit(1);
  if (!oppRow) throw new Error('opportunity not found');

  const outline = (proposal.outline as OutlineSection[] | null) ?? [];
  const sections = (proposal.sections as SectionDraft[] | null) ?? [];
  const compliance = (proposal.complianceMatrix as ComplianceRow[] | null) ?? [];

  const sectionInput = outline.map((o) => {
    const draft = sections.find((s) => s.outlineId === o.id);
    return {
      id: o.id,
      number: o.number,
      title: o.title,
      content: draft?.content ?? '',
      pageLimit: o.pageLimit,
    };
  });

  const fullyAddressed = compliance.filter(
    (c) => c.status === 'fully_addressed' || c.status === 'confirmed',
  ).length;
  const partiallyAddressed = compliance.filter((c) => c.status === 'partially_addressed').length;
  const notAddressed = compliance.filter((c) => c.status === 'not_addressed').length;

  const result = await reviewProposal({
    opportunity: {
      title: oppRow.title,
      agency: oppRow.agencyName,
      jurisdiction: oppRow.jurisdictionName,
      description: oppRow.description,
    },
    company: {
      name: company.name,
      country: company.country,
      capabilities: company.capabilities ?? undefined,
    },
    sections: sectionInput,
    complianceSummary: {
      total: compliance.length,
      fullyAddressed,
      partiallyAddressed,
      notAddressed,
    },
  });

  const aiReview = {
    overallScore: result.overallScore,
    overallVerdict: result.overallVerdict,
    summary: result.summary,
    strengths: result.strengths,
    risks: result.risks,
    sectionFeedback: result.sectionFeedback,
    generatedAt: new Date().toISOString(),
  };

  await db
    .update(proposals)
    .set({ aiReview, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}
