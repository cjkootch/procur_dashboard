// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

export const ReviewProposalOutput = z
  .object({
    overallScore: z.number().min(0).max(100),
    overallVerdict: z.enum(['red', 'yellow', 'green']),
    summary: z
      .string()
      .describe('2-4 sentence executive summary: readiness to submit, biggest risk, biggest strength.'),
    strengths: z
      .array(z.string())
      .describe('3-5 concrete strengths. Reference specific sections or claims.'),
    risks: z
      .array(
        z.object({
          severity: z.enum(['low', 'medium', 'high']),
          text: z.string(),
        }),
      )
      .describe(
        '3-8 concrete risks blocking submission quality. High = must fix before submit, medium = should fix, low = nice to have.',
      ),
    sectionFeedback: z
      .array(
        z.object({
          sectionId: z.string(),
          score: z
            .number()
            .min(0)
            .max(100)
            .describe('0 = empty/placeholder, 100 = bid-ready.'),
          suggestions: z
            .array(z.string())
            .describe('1-4 concrete improvements for this section. Empty array if the section is solid.'),
        }),
      )
      .describe('One entry per section, same order as input.'),
  })
  .strict();

export type ReviewProposalOutputT = z.infer<typeof ReviewProposalOutput>;

export type ReviewProposalInput = {
  opportunity: {
    title: string;
    agency?: string | null;
    jurisdiction: string;
    description?: string | null;
  };
  company: {
    name: string;
    country?: string | null;
    capabilities?: string[];
  };
  sections: Array<{
    id: string;
    number: string;
    title: string;
    content: string;
    pageLimit?: number;
  }>;
  complianceSummary: {
    total: number;
    fullyAddressed: number;
    partiallyAddressed: number;
    notAddressed: number;
  };
};

export type ReviewProposalResult = ReviewProposalOutputT & { usage: CacheUsage };

export async function reviewProposal(input: ReviewProposalInput): Promise<ReviewProposalResult> {
  const instruction = `You are a senior government proposal evaluator reviewing a draft bid before the team submits it.

Your job is to score the proposal and call out specific risks and strengths. Be direct and concrete — bidders win by fixing real gaps, not by being reassured.

Scoring guide:
- 80-100 (green): Submission-ready. Minor polish only.
- 50-79 (yellow): Submittable but with meaningful gaps to close.
- 0-49 (red): Do not submit without major work.

Rules:
- Reference specific section numbers and requirement text. No generalities.
- Section score 0 = empty/placeholder content. 100 = addresses every mandatory content item fluently, with quantified facts and concrete approach.
- Risks ordered severity high → low. "high" means the bid is likely to be non-compliant or evaluated poorly if not fixed.
- Compliance stats are given — reflect them in your overall verdict.
- Short, specific suggestions. "Add 2-3 past performance references relevant to Caribbean energy sector" not "add more references".`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: buildSystem(instruction, undefined),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          opportunity: input.opportunity,
          company: input.company,
          complianceSummary: input.complianceSummary,
          sections: input.sections.map((s) => ({
            id: s.id,
            number: s.number,
            title: s.title,
            pageLimit: s.pageLimit,
            content: s.content.slice(0, 8000),
          })),
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ReviewProposalOutput) },
  });

  if (!response.parsed_output) throw new Error('review-proposal: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
