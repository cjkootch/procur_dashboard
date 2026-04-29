// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

/**
 * Extract distress / motivation signals from a single trade-press
 * article. Used by the RSS ingest worker (Layer 3 of the
 * intelligence-layers brief).
 *
 * Returns:
 *   - hasDistressSignal: top-level decision. False = noise; the
 *     worker discards.
 *   - distressKeyword: the strongest matched keyword (force majeure,
 *     turnaround, layoff, surplus, glut, force majeure, etc.) or null.
 *   - entities: companies/refineries/ports the article names. Country
 *     and role are best-effort and may be null.
 *   - summary: 1-2 sentence neutral synopsis (used as the
 *     entity_news_events.summary value).
 *   - relevanceScore: 0.0-1.0. Below 0.5 = mention without
 *     substantive content; above 0.8 = high signal.
 *
 * Designed for short-form input (RSS title + summary, occasionally
 * the linked article body excerpt). Haiku is more than enough — the
 * task is shallow classification + entity NER, not deep reasoning.
 */
export const ExtractDistressSignalOutput = z
  .object({
    hasDistressSignal: z
      .boolean()
      .describe(
        'True iff the article describes a counterparty-distress event ' +
          '(force majeure, supply disruption, surplus/glut, leadership ' +
          'departure, restructuring, sanctions, refinery turnaround, ' +
          'asset sale, layoffs at a producer/refiner/trader). False for ' +
          'routine market commentary, price movements without context, ' +
          'or general industry news.',
      ),
    distressKeyword: z
      .string()
      .nullable()
      .describe(
        'The single strongest keyword that triggered the signal — ' +
          "e.g. 'force majeure', 'turnaround', 'restructuring', 'glut'. " +
          'Null when hasDistressSignal=false.',
      ),
    entities: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              'Company / refinery / port / trading-house name as it appears in the article.',
            ),
          country: z
            .string()
            .nullable()
            .describe(
              'ISO-2 country code if extractable; null when ambiguous or unspecified.',
            ),
          role: z
            .enum([
              'producer',
              'refiner',
              'trader',
              'port',
              'state-buyer',
              'other',
            ])
            .nullable()
            .describe(
              'Role in the supply chain. Null when unclear from the article.',
            ),
        }),
      )
      .describe(
        'Named entities the article connects to the distress event. ' +
          'Empty when hasDistressSignal=false or no clear entity is named.',
      ),
    summary: z
      .string()
      .describe(
        '1-2 sentence neutral synopsis of the event. Used verbatim as ' +
          'the entity_news_events row summary. Avoid editorialising.',
      ),
    relevanceScore: z
      .number()
      .min(0)
      .max(1)
      .describe(
        '0.0-1.0. Calibrated so 0.5 = "mentions a distress keyword but ' +
          'with limited specificity" and 0.8+ = "concrete event tied to ' +
          'a named counterparty in a specific timeframe".',
      ),
  })
  .strict();

export type ExtractDistressSignalOutputT = z.infer<
  typeof ExtractDistressSignalOutput
>;

export type ExtractDistressSignalInput = {
  feedSource: string;
  title: string;
  /** Article description / summary as published by the feed. */
  description: string;
  /** Article URL — included as context but not fetched here. */
  link: string;
  /** Optional published date in ISO format. */
  publishedAt?: string | null;
};

export type ExtractDistressSignalResult = ExtractDistressSignalOutputT & {
  usage: CacheUsage;
};

const INSTRUCTION = `You read trade-press articles about petroleum, mining, shipping, and metals counterparties and extract distress / motivation signals.

What counts as a distress signal:
- Force majeure declarations or supply disruptions
- Refinery turnarounds, capacity reductions, prolonged outages
- Surplus / glut / oversupply mentions tied to a specific producer or terminal
- Bankruptcy filings, restructurings, asset sales
- Sanctions actions affecting a counterparty
- Leadership changes at producers/traders (especially commercial / trading roles)
- Layoffs at producers, refiners, or trading houses

What does NOT count:
- General market commentary or price movements without an entity-specific event
- Routine corporate announcements (earnings, dividends) unless they name distress
- Articles purely about regulators or policy without a counterparty involved
- Stock-market reactions

Calibrating relevanceScore:
- 0.0-0.4: keyword present but no concrete event (e.g. "no force majeure events occurred")
- 0.5-0.7: event mentioned but vaguely scoped (no clear entity, fuzzy timeline)
- 0.8-1.0: specific entity, specific event, specific timeframe

Be conservative. False positives degrade the assistant's downstream recommendations. Prefer hasDistressSignal=false when in doubt.`;

export async function extractDistressSignal(
  input: ExtractDistressSignalInput,
): Promise<ExtractDistressSignalResult> {
  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 1024,
    system: buildSystem(INSTRUCTION, undefined),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          feedSource: input.feedSource,
          title: input.title,
          description: input.description,
          link: input.link,
          publishedAt: input.publishedAt ?? null,
        }),
      },
    ],
    output_config: {
      format: zodOutputFormat(ExtractDistressSignalOutput),
    },
  });

  if (!response.parsed_output) {
    throw new Error('extract-distress-signal: parse failed');
  }
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
