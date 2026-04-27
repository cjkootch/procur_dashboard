import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { extractUsage, type CacheUsage } from '../prompt-blocks';
import { TranslationOutput, type TranslationOutputT } from '../types';

export type TranslateInput = {
  title: string;
  description?: string;
  /** AI-generated summary, also translated when present so the
   *  Discover card is fully in the target language. */
  summary?: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type TranslateResult = TranslationOutputT & { usage: CacheUsage };

export async function translateOpportunity(
  input: TranslateInput,
): Promise<TranslateResult> {
  if (input.sourceLanguage === input.targetLanguage) {
    return {
      title: input.title,
      description: input.description ?? '',
      summary: input.summary,
      usage: {
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  const instruction = `You translate government tender notices from ${input.sourceLanguage} to ${input.targetLanguage}.

Rules:
- Preserve all reference numbers, dates, currency amounts, and agency names verbatim.
- Use neutral, formal register appropriate to procurement.
- Do not add explanatory notes — translate only what is given.
- Keep paragraph structure.
- For the summary field, keep it to the same number of sentences and the same neutral tone as the source.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: instruction,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? '',
          summary: input.summary ?? '',
        }),
      },
    ],
    output_config: { format: zodOutputFormat(TranslationOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('translate: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
