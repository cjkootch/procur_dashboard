// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

export const MapRequirementsOutput = z
  .object({
    mappings: z
      .array(
        z.object({
          requirementId: z.string(),
          addressedInSection: z
            .string()
            .nullable()
            .describe(
              'The id of the section that best addresses this requirement, or null if no section addresses it yet.',
            ),
          status: z.enum(['not_addressed', 'partially_addressed', 'fully_addressed']),
          confidence: z.number().min(0).max(1),
          notes: z
            .string()
            .describe(
              'One sentence explaining the mapping decision (what in the section addresses the requirement, or why nothing does).',
            ),
        }),
      )
      .describe('One entry per requirement, in the same order as input.'),
  })
  .strict();

export type MapRequirementsOutputT = z.infer<typeof MapRequirementsOutput>;

export type RequirementInput = {
  id: string;
  text: string;
  type: string;
  mandatory: boolean;
};

export type SectionInput = {
  id: string;
  number: string;
  title: string;
  content: string;
};

export type MapRequirementsInput = {
  requirements: RequirementInput[];
  sections: SectionInput[];
};

export type MapRequirementsResult = MapRequirementsOutputT & { usage: CacheUsage };

export async function mapRequirementsToSections(
  input: MapRequirementsInput,
): Promise<MapRequirementsResult> {
  const instruction = `You are a proposal compliance reviewer. You will be given:
1. A numbered list of drafted proposal sections (id, number, title, drafted content).
2. A list of tender requirements (id, text, type, mandatory flag).

For every requirement, decide:
- addressedInSection: the id of the single section whose content best addresses this requirement. null if no section addresses it.
- status: not_addressed (no section speaks to it) / partially_addressed (a section touches on it but misses mandatory sub-items) / fully_addressed (a section fully covers it).
- confidence: 0.0-1.0 — how sure you are of the mapping.
- notes: one sentence, concrete (quote or paraphrase the supporting section text, or name what's missing).

Rules:
- A section with empty or placeholder content can NEVER be fully_addressed.
- Never mark fully_addressed if the requirement is mandatory and the section only mentions it obliquely.
- The output mappings must be in the same order as the input requirements, one entry per requirement.
- Be strict — bidders win by closing real gaps, not by over-rating their draft.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: buildSystem(instruction, undefined),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          sections: input.sections.map((s) => ({
            id: s.id,
            number: s.number,
            title: s.title,
            content: s.content.slice(0, 6000),
          })),
          requirements: input.requirements,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(MapRequirementsOutput) },
  });

  if (!response.parsed_output) throw new Error('map-requirements: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
