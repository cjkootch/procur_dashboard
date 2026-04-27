import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { ClassifyOutput, type ClassifyOutputT } from '../types';

export type ClassifyInput = {
  title: string;
  description?: string;
  agency?: string;
  docText?: string;
  /** Valid taxonomy category slugs from taxonomy_categories.slug */
  taxonomy: Array<{ slug: string; name: string; parentSlug: string | null }>;
};

export type ClassifyResult = ClassifyOutputT & { usage: CacheUsage };

export async function classifyOpportunity(input: ClassifyInput): Promise<ClassifyResult> {
  const topLevel = input.taxonomy.filter((c) => !c.parentSlug);
  const subs = input.taxonomy.filter((c) => c.parentSlug);

  const taxonomyList = [
    ...topLevel.map((c) => `- ${c.slug} (${c.name})`),
    ...subs.map((c) => `  - ${c.slug} (${c.name}, parent: ${c.parentSlug})`),
  ].join('\n');

  const instruction = `You classify government tender opportunities into a fixed taxonomy.

Available categories (pick one top-level slug as "category", and optionally a child slug as "subCategory"):
${taxonomyList}

Rules:
- Always return a valid slug from the list above.
- If the tender spans multiple areas, choose the primary one.
- subCategory must be null unless it is a direct child of the chosen category.
- confidence is 0-1, reflecting how clearly the tender matches.

Respond with a single JSON object matching the schema.`;

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
    output_config: { format: zodOutputFormat(ClassifyOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('classify: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
