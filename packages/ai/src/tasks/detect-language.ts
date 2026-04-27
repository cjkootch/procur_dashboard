import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { extractUsage, type CacheUsage } from '../prompt-blocks';
import { LanguageOutput, type LanguageOutputT } from '../types';

export type DetectLanguageInput = {
  title: string;
  description?: string;
};

export type DetectLanguageResult = LanguageOutputT & { usage: CacheUsage };

export async function detectLanguage(
  input: DetectLanguageInput,
): Promise<DetectLanguageResult> {
  const instruction = `You identify the primary language of a government tender notice.

Return an ISO 639-1 two-letter code:
- en (English) — Caribbean English, Standard English
- es (Spanish) — Dominican Republic, Colombia, Peru, etc.
- pt (Portuguese) — Brazil
- fr (French) — Haiti, French Caribbean
Others may appear. If mixed, choose the dominant language of the main body.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 128,
    system: instruction,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? null,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(LanguageOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('detect-language: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
