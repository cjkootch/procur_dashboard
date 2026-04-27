// Schemas consumed by zodOutputFormat MUST be Zod 4 — see
// packages/ai/src/types.ts for the full explanation.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

export const ExtractCompanyProfileOutput = z
  .object({
    suggestedIndustry: z
      .string()
      .nullable()
      .describe('Best-fit primary industry in a few words, null if unclear.'),
    suggestedCapabilities: z
      .array(z.string())
      .describe('Specific services the company delivers. 5-12 items ideally, each a short phrase.'),
    employeeCountHint: z
      .number()
      .int()
      .nullable()
      .describe('Rough employee count if the site mentions one; null otherwise.'),
    yearFoundedHint: z
      .number()
      .int()
      .nullable()
      .describe('Year founded if the site states it; null otherwise.'),
    summary: z
      .string()
      .describe('One-sentence company summary evaluators would recognize.'),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ExtractCompanyProfileOutputT = z.infer<typeof ExtractCompanyProfileOutput>;

export type ExtractCompanyProfileInput = {
  websiteUrl: string;
  websiteText: string;
};

export type ExtractCompanyProfileResult = ExtractCompanyProfileOutputT & { usage: CacheUsage };

export async function extractCompanyProfile(
  input: ExtractCompanyProfileInput,
): Promise<ExtractCompanyProfileResult> {
  const instruction = `You extract a company profile from its public website text.

Your output will seed a government-contracting profile used to draft proposals. Be specific and avoid marketing fluff — evaluators will read what you write.

Rules:
- suggestedCapabilities: list specific services, not vague virtues. "Cybersecurity consulting for financial services" beats "excellence and innovation". 5-12 items, each a short phrase.
- suggestedIndustry: the primary sector. null if truly mixed.
- employeeCountHint / yearFoundedHint: only populate if the page states them explicitly.
- summary: one sentence, 15-30 words, describing what the company does for whom.
- Never invent claims. If the page is thin or marketing-only, lower confidence and keep capabilities short.`;

  const truncated = input.websiteText.slice(0, 30_000);
  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 1536,
    system: buildSystem(instruction, undefined),
    messages: [
      {
        role: 'user',
        content: `Website URL: ${input.websiteUrl}\n\nExtracted text:\n\n${truncated}`,
      },
    ],
    output_config: { format: zodOutputFormat(ExtractCompanyProfileOutput) },
  });

  if (!response.parsed_output) throw new Error('extract-company-profile: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
