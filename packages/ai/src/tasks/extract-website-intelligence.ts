// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

/**
 * Website-intelligence extraction.
 *
 * Per the website-metadata-layer agreed-scope from chat: extract
 * structured facts + multi-section summaries from concatenated
 * website text, in one Sonnet call. Capped fact + summary lengths
 * keep the output payload tight.
 *
 * Confidence framing: this is marketing self-presentation, not
 * regulatory disclosure. Defaults sit at 0.4-0.6. Sonnet is asked
 * to self-rate per fact; the analyst can promote individual facts
 * via override later.
 */

export const FACT_TYPES = [
  'commercial_role',
  'product',
  'service',
  'country_served',
  'port',
  'terminal',
  'refinery',
  'mine',
  'power_plant',
  'contact_email',
  'contact_phone',
  'decision_maker_role',
  'certification',
  'license',
] as const;

export const SUMMARY_KINDS = [
  'company_overview',
  'products_services',
  'operations',
  'fuel_relevance',
  'crude_relevance',
  'logistics_relevance',
  'contact_path',
] as const;

export const WebsiteIntelligenceOutput = z
  .object({
    facts: z
      .array(
        z.object({
          factType: z.enum(FACT_TYPES).describe('Categorization of the fact.'),
          value: z
            .string()
            .min(1)
            .max(300)
            .describe(
              "Fact value, capture-as-disclosed. Examples: 'diesel', " +
                "'Trinidad and Tobago', 'Port of Kingston', " +
                "'investor.relations@example.com', 'ISO 9001:2015'.",
            ),
          evidenceText: z
            .string()
            .max(500)
            .describe(
              'Short excerpt from the page text that supports this fact. ' +
                "Audit trail. Empty string when the fact comes from the page's " +
                'overall framing rather than a specific quote.',
            ),
          confidence: z
            .number()
            .min(0)
            .max(1)
            .describe(
              'Self-assessed confidence (0-1). 0.7+ for clear quoted facts; ' +
                '0.4-0.6 for facts inferred from context; < 0.3 for guesses.',
            ),
          sourceUrl: z
            .string()
            .describe('The URL of the page that surfaced this fact.'),
        }),
      )
      .max(80)
      .describe(
        'All extracted facts. Cap at 80 to keep the output tight — pick ' +
          'highest-confidence + most-distinct facts when there are more.',
      ),
    summaries: z
      .array(
        z.object({
          sectionKind: z.enum(SUMMARY_KINDS),
          content: z
            .string()
            .max(4000)
            .describe(
              'Markdown-friendly. Tight prose, no filler. Empty string ' +
                "when the entity's website doesn't address this section.",
            ),
        }),
      )
      .describe(
        'One entry per section_kind (7 total). Empty content acceptable.',
      ),
    notes: z
      .string()
      .max(2000)
      .describe(
        'Extraction notes — caveats, language detected if non-English, ' +
          'what the website does not cover. Keep to one paragraph; cap is ' +
          '2000 chars but most cases need <300.',
      ),
  })
  .strict();

export type WebsiteIntelligenceOutputT = z.infer<typeof WebsiteIntelligenceOutput>;
export type WebsiteIntelligenceExtractResult = WebsiteIntelligenceOutputT & {
  usage: CacheUsage;
};

/**
 * Single Sonnet pass over the concatenated website text. Caller is
 * responsible for trimming / concatenating the page text payload —
 * keep total under ~150K tokens to fit the cached system prompt
 * efficiently.
 */
export async function extractWebsiteIntelligence(args: {
  entityName: string;
  /** Pages already fetched + extracted. Each: page kind, URL, plain text. */
  pages: Array<{ kind: string; url: string; text: string }>;
  /** Optional country/region context to ground geographic facts. */
  countryHint?: string | null;
}): Promise<WebsiteIntelligenceExtractResult> {
  const concatenated = args.pages
    .map(
      (p) =>
        `=== PAGE [${p.kind}] ${p.url} ===\n${p.text.slice(0, 20_000)}`,
    )
    .join('\n\n');

  const instruction = `You are a commercial-counterparty analyst extracting structured intelligence from a company's website. The user has supplied concatenated text from up to 10 high-signal pages (homepage, about, products, services, operations, assets, investors, sustainability, contact, terminals, refineries, fleet, projects).

Entity name: ${args.entityName}${args.countryHint ? `\nCountry hint: ${args.countryHint}` : ''}

What you're hunting for:

FACTS — structured (factType, value, evidence, confidence, sourceUrl) entries. Coverage targets:
  - commercial_role: "refiner" / "trader" / "shipping operator" / "mining producer" etc. Usually 1-2.
  - product / service: refined fuels, crude grades, services offered. As many as the site discloses.
  - country_served: ISO country names mentioned as operating geography.
  - port / terminal / refinery / mine / power_plant: physical assets mentioned.
  - contact_email / contact_phone: published contact details.
  - decision_maker_role: titles like "Head of Procurement", "VP Trading", "Chief Commercial Officer".
  - certification / license: ISO, Bureau Veritas, jurisdictional licenses, etc.

SUMMARIES — exactly 7 sections (one per SUMMARY_KIND). Tight prose, no filler. Each ≤4KB:
  - company_overview: who they are, headquartered where, scale signal
  - products_services: what they offer commercially
  - operations: physical operations + locations
  - fuel_relevance: how this entity relates to refined-product trading (buy / sell / use)
  - crude_relevance: same for crude oil
  - logistics_relevance: vessels, ports, terminals, freight
  - contact_path: who/what to reach out about commercial discussion + how

Rules:
  - Confidence framing: website data is marketing self-presentation. Default 0.4-0.6 unless the fact is a direct quoted disclosure (then up to 0.8). Never above 0.85.
  - Quoted contact emails / phone numbers / certifications can carry confidence 0.7-0.8.
  - Empty summary content is acceptable when the website doesn't address that section. Don't fabricate.
  - Empty-string evidence is acceptable when the fact comes from page framing rather than a specific quote.
  - sourceUrl on each fact must match one of the supplied page URLs.
  - notes: caveats, language detected if non-English, what the website doesn't cover.

If the supplied text is empty / under 1KB / clearly an error page, return facts=[], summaries with empty content, and explain in notes.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 8192,
    system: buildSystem(instruction, concatenated),
    messages: [
      {
        role: 'user',
        content:
          'Extract per the schema. Be strict about confidence — do not over-state.',
      },
    ],
    output_config: { format: zodOutputFormat(WebsiteIntelligenceOutput) },
  });

  if (!response.parsed_output) throw new Error('extract-website-intelligence: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
