import { and, eq } from 'drizzle-orm';
import {
  agencies,
  companies,
  db,
  jurisdictions,
  opportunities,
  proposals,
  pursuits,
} from '@procur/db';
import { draftSection, embedText, meter, MODELS } from '@procur/ai';
import { semanticSearchLibrary } from '../../../../lib/library-queries';
import { semanticSearchPastPerformance } from '../../../../lib/past-performance-queries';
import { authenticateWordAddinRequest, jsonResponse, unauthorized } from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 60;

type OutlineSection = {
  id: string;
  number: string;
  title: string;
  description: string;
  evaluationCriteria: string[];
  pageLimit?: number;
  mandatoryContent: string[];
};

type DraftBody = {
  proposalId: string;
  sectionId?: string;
  /** Free-text instruction the user typed in the taskpane. Optional. */
  instruction?: string;
};

/**
 * POST /api/word-addin/draft
 *
 * Reuses the same draftSection() pipeline as the in-app draft action,
 * just authenticated by token instead of Clerk session. Returns the
 * generated content as plain text (with paragraph breaks) for the
 * taskpane to insert into the Word document at the cursor.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateWordAddinRequest(req);
  if (!auth) return unauthorized();

  let body: DraftBody;
  try {
    body = (await req.json()) as DraftBody;
  } catch {
    return jsonResponse({ error: 'invalid json body' }, { status: 400 });
  }
  const proposalId = String(body.proposalId ?? '');
  const sectionId = body.sectionId ? String(body.sectionId) : null;
  const instruction = body.instruction ? String(body.instruction).trim() : '';
  if (!proposalId) return jsonResponse({ error: 'proposalId required' }, { status: 400 });

  // Ownership-checked load of (proposal, pursuit, opportunity, company).
  const [row] = await db
    .select({
      proposal: proposals,
      pursuit: pursuits,
      opportunity: opportunities,
      agency: agencies,
      jurisdiction: jurisdictions,
      company: companies,
    })
    .from(proposals)
    .innerJoin(pursuits, eq(pursuits.id, proposals.pursuitId))
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .innerJoin(companies, eq(companies.id, pursuits.companyId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(proposals.id, proposalId), eq(pursuits.companyId, auth.companyId)))
    .limit(1);

  if (!row) return jsonResponse({ error: 'proposal not found' }, { status: 404 });

  const outline = (row.proposal.outline as OutlineSection[] | null) ?? [];
  // If a section is specified, draft for that section. Otherwise pick the
  // first section in the outline as a fallback so single-shot "give me a
  // draft" requests still work without configuring a section.
  const section = sectionId ? outline.find((s) => s.id === sectionId) : outline[0];
  if (!section) {
    return jsonResponse(
      { error: 'no outline section available — open the proposal in app first' },
      { status: 400 },
    );
  }

  // Retrieval — best-effort. If embeddings aren't configured, still draft.
  const retrievalQuery = [
    section.title,
    section.description,
    ...section.mandatoryContent.slice(0, 5),
    ...section.evaluationCriteria,
    instruction,
  ]
    .filter(Boolean)
    .join('\n');

  let libraryExcerpts: Array<{ title: string; type: string; content: string }> = [];
  try {
    const queryEmb = await embedText(retrievalQuery);
    const [libHits, ppHits] = await Promise.all([
      semanticSearchLibrary(auth.companyId, queryEmb, 5),
      semanticSearchPastPerformance(auth.companyId, queryEmb, 3),
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
    console.warn('[word-addin/draft] library retrieval skipped:', err);
  }

  const result = await draftSection({
    opportunity: {
      title: row.opportunity.title,
      agency: row.agency?.name ?? null,
      jurisdiction: row.jurisdiction.name,
      referenceNumber: row.opportunity.referenceNumber,
      description: row.opportunity.description,
    },
    company: {
      name: row.company.name,
      country: row.company.country,
      capabilities: row.company.capabilities ?? undefined,
    },
    section: {
      number: section.number,
      title: section.title,
      description: section.description,
      evaluationCriteria: section.evaluationCriteria,
      mandatoryContent: section.mandatoryContent,
      pageLimit: section.pageLimit,
    },
    libraryExcerpts,
    userInstruction: instruction || undefined,
  });

  await meter({
    companyId: auth.companyId,
    source: 'draft_section',
    model: MODELS.sonnet,
    usage: result.usage,
  });

  return jsonResponse({
    section: { id: section.id, number: section.number, title: section.title },
    content: result.content,
    wordCount: result.wordCount,
    coverageNotes: result.coverageNotes,
  });
}
