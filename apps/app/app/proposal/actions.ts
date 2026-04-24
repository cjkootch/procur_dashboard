'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  proposalComments,
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

/**
 * Records that a proposal was submitted. Captures an optional submission
 * confirmation (ref number, receipt text), sets status=submitted, records
 * submittedBy + submittedAt, and advances the pursuit stage to 'submitted'
 * if it isn't already past that point.
 */
export async function markProposalSubmittedAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const confirmation = String(formData.get('submissionConfirmation') ?? '').trim();

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true, stage: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
    columns: { id: true },
  });
  if (!proposal) throw new Error('proposal not found');

  const now = new Date();
  await db
    .update(proposals)
    .set({
      status: 'submitted',
      submittedAt: now,
      submittedBy: user.id,
      submissionConfirmation: confirmation.length > 0 ? confirmation : null,
      updatedAt: now,
    })
    .where(eq(proposals.id, proposal.id));

  const advanceableStages = new Set([
    'identification',
    'qualification',
    'capture_planning',
    'proposal_development',
  ]);
  if (advanceableStages.has(pursuit.stage)) {
    await db
      .update(pursuits)
      .set({ stage: 'submitted', updatedAt: now })
      .where(eq(pursuits.id, pursuitId));
    revalidatePath(`/capture/pursuits/${pursuitId}`);
  }

  revalidatePath(`/proposal/${pursuitId}`);
}

/**
 * Reverts a submission (for fixing a mis-click or re-opening for revision).
 * Proposal status → in_review. Pursuit stage is left alone — user can move
 * it explicitly from the capture page.
 */
export async function unmarkProposalSubmittedAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');

  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('pursuit not found');

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
    columns: { id: true },
  });
  if (!proposal) throw new Error('proposal not found');

  await db
    .update(proposals)
    .set({
      status: 'in_review',
      submittedAt: null,
      submittedBy: null,
      submissionConfirmation: null,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

async function requireOwnedProposal(companyId: string, pursuitId: string) {
  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('pursuit not found');
  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
    columns: { id: true },
  });
  if (!proposal) throw new Error('proposal not found');
  return proposal;
}

export async function addProposalCommentAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!body) throw new Error('comment body required');
  const sectionIdRaw = formData.get('sectionId');
  const sectionId =
    typeof sectionIdRaw === 'string' && sectionIdRaw.length > 0 ? sectionIdRaw : null;

  const proposal = await requireOwnedProposal(company.id, pursuitId);

  await db.insert(proposalComments).values({
    proposalId: proposal.id,
    sectionId,
    body,
    createdBy: user.id,
  });

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function resolveProposalCommentAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const commentId = String(formData.get('commentId') ?? '');
  if (!commentId) throw new Error('commentId required');
  const proposal = await requireOwnedProposal(company.id, pursuitId);

  await db
    .update(proposalComments)
    .set({ resolvedAt: new Date(), resolvedBy: user.id, updatedAt: new Date() })
    .where(
      and(eq(proposalComments.id, commentId), eq(proposalComments.proposalId, proposal.id)),
    );

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function reopenProposalCommentAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const commentId = String(formData.get('commentId') ?? '');
  if (!commentId) throw new Error('commentId required');
  const proposal = await requireOwnedProposal(company.id, pursuitId);

  await db
    .update(proposalComments)
    .set({ resolvedAt: null, resolvedBy: null, updatedAt: new Date() })
    .where(
      and(eq(proposalComments.id, commentId), eq(proposalComments.proposalId, proposal.id)),
    );

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function deleteProposalCommentAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const commentId = String(formData.get('commentId') ?? '');
  if (!commentId) throw new Error('commentId required');
  const proposal = await requireOwnedProposal(company.id, pursuitId);

  await db
    .delete(proposalComments)
    .where(
      and(eq(proposalComments.id, commentId), eq(proposalComments.proposalId, proposal.id)),
    );

  revalidatePath(`/proposal/${pursuitId}`);
}

async function loadOutlineAndSections(companyId: string, pursuitId: string) {
  const pursuit = await db.query.pursuits.findFirst({
    where: and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, companyId)),
    columns: { id: true },
  });
  if (!pursuit) throw new Error('pursuit not found');
  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) throw new Error('proposal not found');
  const outline = (proposal.outline as OutlineSection[] | null) ?? [];
  const sections = (proposal.sections as SectionDraft[] | null) ?? [];
  return { proposal, outline, sections };
}

function renumberOutline(outline: OutlineSection[]): OutlineSection[] {
  return outline.map((o, i) => ({ ...o, number: String(i + 1) }));
}

export async function addProposalSectionAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!title) throw new Error('title required');

  const { proposal, outline, sections } = await loadOutlineAndSections(
    company.id,
    pursuitId,
  );

  const newOutlineId = randomUUID();
  const newSectionId = randomUUID();

  const nextOutline = renumberOutline([
    ...outline,
    {
      id: newOutlineId,
      number: String(outline.length + 1),
      title,
      description,
      evaluationCriteria: [],
      mandatoryContent: [],
    },
  ]);

  const nextSections: SectionDraft[] = [
    ...sections,
    {
      id: newSectionId,
      outlineId: newOutlineId,
      title,
      content: '',
      status: 'empty',
      wordCount: 0,
      lastEditedAt: new Date().toISOString(),
    },
  ];

  await db
    .update(proposals)
    .set({ outline: nextOutline, sections: nextSections, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function removeProposalSectionAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const outlineId = String(formData.get('outlineId') ?? '');
  if (!outlineId) throw new Error('outlineId required');

  const { proposal, outline, sections } = await loadOutlineAndSections(
    company.id,
    pursuitId,
  );

  const nextOutline = renumberOutline(outline.filter((o) => o.id !== outlineId));
  const nextSections = sections.filter((s) => s.outlineId !== outlineId);

  await db
    .update(proposals)
    .set({ outline: nextOutline, sections: nextSections, updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}

export async function moveProposalSectionAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const pursuitId = String(formData.get('pursuitId') ?? '');
  const outlineId = String(formData.get('outlineId') ?? '');
  const direction = String(formData.get('direction') ?? '');
  if (!outlineId || (direction !== 'up' && direction !== 'down')) {
    throw new Error('outlineId and direction=up|down required');
  }

  const { proposal, outline } = await loadOutlineAndSections(company.id, pursuitId);
  const idx = outline.findIndex((o) => o.id === outlineId);
  if (idx === -1) throw new Error('section not found in outline');
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= outline.length) return;

  const next = [...outline];
  const tmp = next[idx]!;
  next[idx] = next[swapIdx]!;
  next[swapIdx] = tmp;

  await db
    .update(proposals)
    .set({ outline: renumberOutline(next), updatedAt: new Date() })
    .where(eq(proposals.id, proposal.id));

  revalidatePath(`/proposal/${pursuitId}`);
}
