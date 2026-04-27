// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { EnrichCoreOutput, type EnrichCoreOutputT } from '../types';

export type EnrichCoreInput = {
  title: string;
  description?: string;
  agency?: string;
  docText?: string;
  /** Valid taxonomy category slugs from taxonomy_categories.slug */
  taxonomy: Array<{ slug: string; name: string; parentSlug: string | null }>;
};

export type EnrichCoreResult = EnrichCoreOutputT & { usage: CacheUsage };

/**
 * Single Haiku call replacing detect-language + classify + summarize.
 *
 * Why: each separate call duplicated the same input (title +
 * description + agency + docText) and the same model warmup. Combining
 * cuts ~60% of per-opportunity AI cost. The static portion of the
 * system prompt (instruction + taxonomy list) is the same for every
 * call, so AI Gateway prompt caching reads it from cache after the
 * first call of the day.
 */
export async function enrichCore(input: EnrichCoreInput): Promise<EnrichCoreResult> {
  const topLevel = input.taxonomy.filter((c) => !c.parentSlug);
  const subs = input.taxonomy.filter((c) => c.parentSlug);

  const taxonomyList = [
    ...topLevel.map((c) => `- ${c.slug} (${c.name})`),
    ...subs.map((c) => `  - ${c.slug} (${c.name}, parent: ${c.parentSlug})`),
  ].join('\n');

  const instruction = `You enrich government tender opportunities by simultaneously detecting their language, classifying into a fixed taxonomy, and writing a short neutral summary.

Available taxonomy categories (pick one top-level slug as "category", and optionally a child slug as "subCategory"):
${taxonomyList}

Rules:
- language: ISO 639-1 two-letter code. en (English/Caribbean English), es (Spanish — DR/Colombia/Peru/etc), pt (Portuguese — Brazil), fr (French — Haiti/French Caribbean), etc. Choose dominant language of the main body if mixed.
- category: must be a valid top-level slug from the list. Pick the primary area if the tender spans multiple.
- subCategory: must be a direct child of the chosen category, or null.
- summary: ALWAYS written in plain English regardless of source language. 2-3 sentences, under 60 words. Start with what is being procured, then who is procuring it. Include rough scale/scope when stated. No jargon, no marketing, no emojis. Don't repeat the title verbatim.
- confidence: 0-1, reflecting how clearly the tender matches the taxonomy.

Respond with a single JSON object matching the schema.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 768,
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
    output_config: { format: zodOutputFormat(EnrichCoreOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('enrich-core: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
