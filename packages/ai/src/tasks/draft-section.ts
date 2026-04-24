import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { DraftSectionOutput, type DraftSectionOutputT } from '../types';

export type LibraryExcerpt = {
  title: string;
  type: string;
  content: string;
};

export type DraftSectionInput = {
  opportunity: {
    title: string;
    agency?: string | null;
    jurisdiction: string;
    referenceNumber?: string | null;
    description?: string | null;
  };
  company: {
    name: string;
    country?: string | null;
    capabilities?: string[];
  };
  section: {
    number: string;
    title: string;
    description: string;
    evaluationCriteria: string[];
    mandatoryContent: string[];
    pageLimit?: number;
  };
  /** Optional: full tender document text for caching across multiple section drafts. */
  docText?: string;
  /** Top-k library entries retrieved via semantic search. */
  libraryExcerpts: LibraryExcerpt[];
  /** Optional: existing content (for regeneration with user guidance). */
  existingContent?: string;
  /** Optional: user-provided guidance for the regeneration. */
  userInstruction?: string;
};

export type DraftSectionResult = DraftSectionOutputT & { usage: CacheUsage };

export async function draftSection(input: DraftSectionInput): Promise<DraftSectionResult> {
  const pageBudget = input.section.pageLimit
    ? `${input.section.pageLimit} pages max (~${input.section.pageLimit * 400} words)`
    : '400-800 words';

  const instruction = `You are a senior government proposal writer for Caribbean, Latin American, and African markets. You are drafting Section ${input.section.number}: "${input.section.title}" of a bid response.

Company writing the bid: ${input.company.name}${input.company.country ? ` (${input.company.country})` : ''}.
Buyer: ${input.opportunity.agency ?? input.opportunity.jurisdiction} · tender: "${input.opportunity.title}"${input.opportunity.referenceNumber ? ` · ref ${input.opportunity.referenceNumber}` : ''}.

Section objective: ${input.section.description}

${
  input.section.evaluationCriteria.length > 0
    ? `Evaluation criteria this section must address:\n${input.section.evaluationCriteria.map((c) => `- ${c}`).join('\n')}\n`
    : ''
}
${
  input.section.mandatoryContent.length > 0
    ? `Requirements that must be covered:\n${input.section.mandatoryContent.map((r) => `- ${r}`).join('\n')}\n`
    : ''
}
${
  input.libraryExcerpts.length > 0
    ? `Relevant company content from our library you may quote or adapt:\n${input.libraryExcerpts
        .map(
          (e, i) =>
            `[LIB-${i + 1}] ${e.title} (${e.type})\n${e.content.slice(0, 2000)}`,
        )
        .join('\n\n')}\n`
    : ''
}
${
  input.existingContent
    ? `Current draft of this section (may be revised):\n"""${input.existingContent.slice(0, 4000)}"""\n`
    : ''
}
${input.userInstruction ? `User guidance: ${input.userInstruction}\n` : ''}

Rules:
- Write ${pageBudget}. Use short paragraphs, professional register, no marketing puff.
- Reference the buyer by name. Do not invent capabilities the library doesn't support.
- Surface quantified facts when the library provides them.
- Do not use placeholders like "[Company Name]" or "[TBD]".
- Output plain text with paragraph breaks (\\n\\n). No markdown headings.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: buildSystem(instruction, input.docText),
    messages: [
      {
        role: 'user',
        content: `Draft Section ${input.section.number}: ${input.section.title}.`,
      },
    ],
    output_config: { format: zodOutputFormat(DraftSectionOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('draft-section: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
