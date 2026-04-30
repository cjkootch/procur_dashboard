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
    isFuelMarketNews: z
      .boolean()
      .describe(
        'True iff the article is materially about the petroleum / fuel ' +
          'trading market — Brent/WTI/refined-spot moves with named ' +
          'drivers, OPEC+ decisions, refinery margins, freight / shipping ' +
          'rate moves, sanctions changes affecting supply, geopolitical ' +
          'events with a clear fuel-market consequence. Even when no ' +
          'specific tracked counterparty is named — operators want this ' +
          'context on the brief. False for general industry chatter, ' +
          'corporate earnings, equity-market reactions without a fuel-' +
          'specific lens, or off-topic commodity news (gold, ag, etc.).',
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

const INSTRUCTION = `You read trade-press articles about petroleum, fuel trading, refining, shipping, and metals. Tag each article with TWO independent signals.

═══ SIGNAL 1 — hasDistressSignal ═══

True iff the article describes a counterparty-distress event tied to a NAMED company / refinery / port / trading house:
- Force majeure declarations or supply disruptions
- Refinery turnarounds, capacity reductions, prolonged outages
- Surplus / glut / oversupply mentions tied to a specific producer or terminal
- Bankruptcy filings, restructurings, asset sales
- Sanctions actions affecting a counterparty
- Leadership changes at producers / traders (especially commercial / trading roles)
- Layoffs at producers, refiners, or trading houses

What does NOT count as distress:
- General market commentary or price movements without an entity-specific event
- Routine corporate announcements (earnings, dividends) unless they name distress
- Articles purely about regulators or policy without a counterparty involved
- Stock-market reactions

═══ SIGNAL 2 — isFuelMarketNews ═══

True iff the article gives material fuel-market context that an oil trader would want to see on their morning brief, EVEN WHEN no tracked counterparty is named:
- Brent / WTI / refined-product spot moves with named drivers ("Brent up 3% on Mideast tensions")
- OPEC+ decisions, voluntary cuts, compliance discussions
- Refinery-margin moves (crack spreads widening / narrowing)
- Freight / tanker rate moves (Worldscale, dirty/clean)
- Sanctions changes affecting global supply (Russian oil, Venezuelan crude, Iran)
- Geopolitical events with a clear fuel-market consequence (canal disruptions, pipeline attacks)

What does NOT count as fuel-market news:
- Off-topic commodity news (gold, copper, ag, lithium without a fuel angle)
- Equity-market commentary on energy stocks (price action without a fundamental driver)
- Corporate earnings recaps (unless they name supply / cost shifts that move physical markets)
- Generic ESG / energy-transition commentary without a near-term physical-trade implication

═══ The two flags are INDEPENDENT ═══

An article CAN have both true (e.g. "Vitol declares force majeure on Libyan loadings, lifts global diesel cracks 5%" → both distress and market). Most articles will have at most one true. False for both = noise; the worker drops it.

Calibrating relevanceScore (single value, applies to whichever signal is dominant):
- 0.0-0.4: keyword present but no concrete event
- 0.5-0.7: event mentioned but vaguely scoped (no clear entity, fuzzy timeline / driver)
- 0.8-1.0: specific entity / specific market move / specific timeframe

Be conservative on distress (false positives in counterparty news degrade deal recommendations). Be moderately permissive on fuel-market news — operators would rather see a slightly soft market story than miss a real move.`;

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
