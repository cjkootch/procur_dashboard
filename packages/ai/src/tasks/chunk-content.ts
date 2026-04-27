// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { extractUsage, type CacheUsage } from '../prompt-blocks';

const LIBRARY_TYPES = [
  'capability_statement',
  'team_bio',
  'past_performance',
  'boilerplate',
  'certification',
  'executive_summary',
  'technical_approach',
  'management_plan',
] as const;

export const ChunkContentOutput = z
  .object({
    chunks: z
      .array(
        z.object({
          title: z.string().describe('Short descriptive title (5-10 words)'),
          type: z
            .enum(LIBRARY_TYPES)
            .describe('Best-fit library entry type'),
          content: z
            .string()
            .describe('The chunk content, preserving the original wording'),
          tags: z
            .array(z.string())
            .describe('2-5 relevant short tags (industries, capabilities, client types)'),
        }),
      )
      .describe('Logical reusable chunks — one entry per distinct reusable unit'),
  })
  .strict();

export type ChunkContentOutputT = z.infer<typeof ChunkContentOutput>;

export type ChunkContentInput = {
  sourceName: string;
  text: string;
};

export type ChunkContentResult = ChunkContentOutputT & { usage: CacheUsage };

/**
 * Split a large document (past proposal, capability statement, etc) into
 * logical chunks that each become a standalone library entry. We use Haiku
 * for cost — this task is structurally simple and doesn't need Sonnet's
 * reasoning depth. The chunker preserves original wording so the output
 * is quotable by the AI drafter later.
 */
export async function chunkContent(input: ChunkContentInput): Promise<ChunkContentResult> {
  const instruction = `You split reusable company content into library entries for future proposal writing.

The input is the text of a document named "${input.sourceName}". It may be a past proposal, a capability statement, a bank of team bios, a cover-letter template, or any mix of reusable content.

Rules:
- Return 1-20 chunks. Bigger source documents warrant more chunks.
- Each chunk should be a coherent, standalone reusable unit — not a sentence fragment, not the entire document.
- Preserve original wording verbatim where possible. Do not paraphrase.
- Pick the single best-fit type per chunk. When in doubt, use "boilerplate".
- Skip table-of-contents pages, cover pages, page numbers, and obvious headers/footers.
- If a chunk's reusability is marginal (highly bid-specific), skip it.

Content types:
- capability_statement: company overview, capabilities, differentiators
- team_bio: individual CVs, leadership bios
- past_performance: specific prior project descriptions with client, scope, outcomes
- boilerplate: generic reusable prose (mission, QA approach, methodology)
- certification: ISO, quality, industry certifications
- executive_summary: exec-summary templates
- technical_approach: technical methodology templates
- management_plan: governance, reporting, risk approach templates`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 8192,
    system: instruction,
    messages: [
      {
        role: 'user',
        content: `Source: ${input.sourceName}\n\n---\n\n${input.text.slice(0, 60_000)}`,
      },
    ],
    output_config: { format: zodOutputFormat(ChunkContentOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('chunk-content: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
