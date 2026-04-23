import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { SummaryOutput, type SummaryOutputT } from '../types';

export type SummarizeInput = {
  title: string;
  description?: string;
  agency?: string;
  docText?: string;
};

export type SummarizeResult = SummaryOutputT & { usage: CacheUsage };

export async function summarizeOpportunity(
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const instruction = `You write neutral 2-3 sentence summaries of government tender opportunities for procurement professionals.

Rules:
- 2-3 sentences, under 60 words total.
- Start with what is being procured, then who is procuring it.
- Include the rough scale or scope when stated.
- Plain English — no jargon, no marketing language, no emojis.
- Do not repeat the title verbatim.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 512,
    system: buildSystem(instruction, input.docText),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? null,
          agency: input.agency ?? null,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(SummaryOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('summarize: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
