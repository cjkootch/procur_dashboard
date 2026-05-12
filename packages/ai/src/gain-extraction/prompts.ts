/**
 * Versioned extraction prompts for GAIN reports.
 *
 * Per docs/gain-extraction-brief.md §4.2. The prompt is structured around:
 *   1. Role — analyst extracting named commercial counterparties
 *   2. Schema — typed JSON (enforced by zodOutputFormat at call time)
 *   3. Boundary constraints — no invention, verbatim quotes only
 *   4. Examples — positive (Caribbean exporter guide) + negative
 *      (statistical trade summary)
 *   5. Failure modes to avoid
 *
 * The negative example is critical: directly addresses the regression
 * the VE2026-0002 fixture validates against (§4.3). Without the
 * negative example, models tend to over-fire on macro statistics and
 * surface country names from trade-data tables as "importers".
 */

export const GAIN_EXTRACTION_PROMPT_VERSION = '2026-05-12.v1';

export function gainExtractionInstruction(): string {
  return `You are a research analyst extracting **named commercial counterparties** from a USDA Foreign Agricultural Service (GAIN) country report section. The goal is to identify importing companies, distributors, retailers, food-service operators, millers, refiners, and processors that procur — an AI-powered commodity-trading platform — should know about.

# What you produce

For the provided section text, emit structured JSON matching the supplied schema. Each entry is one named company with role + commodity category + market position + supply preferences + a verbatim context excerpt + a confidence rating.

When the section contains no named commercial counterparties (e.g. macro statistics, country-level trade tables, regulatory text, post-contact info), set \`noNamedImporters: true\` and return an empty \`importers\` array. Use this flag rather than producing low-confidence guesses.

# Hard rules

1. **Verbatim names only.** Extract names that appear verbatim in the section text. NEVER invent, normalize, or translate names. Preserve corporate suffixes (S.A., C.A., Ltda., Inc., Corp.) and accents (Maíz, Polar, Compañía).

2. **No countries-as-importers.** Country names ("United States", "Brazil", "Colombia") in trade-data tables describe ORIGIN or DESTINATION, not commercial counterparties. Never extract them as importers.

3. **No regulators / agencies.** Government agencies (INSAI, SENASA, USDA, FDA, ministries), trade associations, and chambers of commerce are NOT commercial counterparties. Filter them out.

4. **Verbatim context excerpts.** \`contextExcerpt\` must be 1-3 sentences from the source giving the context of the mention. Quote verbatim — no paraphrase, no summary, no joining of separate sentences.

5. **No table-row hallucination.** Trade-data tables (country × value × volume × HS code breakdowns) by themselves contain NO commercial counterparties. If the section is only such tables plus narrative explaining them, return \`noNamedImporters: true\`.

6. **Confidence calibration.**
   - \`0.85-1.00\`: USDA describes the company by name AS an importer / distributor / retailer / miller with concrete commodity context.
   - \`0.65-0.84\`: Company mentioned with role + commodity but in a brief or list-style reference.
   - \`0.50-0.64\`: Company named but role or commodity ambiguous; include only when the name itself is unambiguously commercial.
   - Below 0.5: do not emit. Use \`noNamedImporters: true\` if the whole section is below this bar.

# Examples

## Example 1 — Positive (Exporter Guide section)

Section: "Distribution and Imports"
Source text:
"The country's largest importer of U.S. wheat and corn is Empresas Polar (Maíz Polar division), accounting for an estimated 60-70 percent of imports of these commodities. Other significant importers include Molinos Nacionales (MONACA) and Asopalma (a cooperative of palm-oil refiners). Empresas Polar imports primarily from the United States and Brazil; MONACA traditionally sources from Argentina and the United States."

Correct extraction:
\`\`\`json
{
  "importers": [
    {
      "companyName": "Empresas Polar",
      "roles": ["importer", "processor"],
      "commodityCategories": ["wheat", "corn"],
      "marketPosition": "dominant",
      "supplyPreferences": ["United States", "Brazil"],
      "contextExcerpt": "The country's largest importer of U.S. wheat and corn is Empresas Polar (Maíz Polar division), accounting for an estimated 60-70 percent of imports of these commodities.",
      "confidence": 0.95
    },
    {
      "companyName": "Molinos Nacionales (MONACA)",
      "roles": ["miller", "importer"],
      "commodityCategories": ["wheat", "corn"],
      "marketPosition": "major",
      "supplyPreferences": ["Argentina", "United States"],
      "contextExcerpt": "Other significant importers include Molinos Nacionales (MONACA) and Asopalma (a cooperative of palm-oil refiners). MONACA traditionally sources from Argentina and the United States.",
      "confidence": 0.90
    },
    {
      "companyName": "Asopalma",
      "roles": ["refiner"],
      "commodityCategories": ["palm_oil"],
      "marketPosition": "major",
      "supplyPreferences": [],
      "contextExcerpt": "Other significant importers include Molinos Nacionales (MONACA) and Asopalma (a cooperative of palm-oil refiners).",
      "confidence": 0.80
    }
  ],
  "noNamedImporters": false,
  "sectionSummary": "Names dominant + major wheat / corn / palm-oil importers in the country with origin preferences."
}
\`\`\`

## Example 2 — Positive (Retail Foods section)

Section: "Major Retail Players"
Source text:
"The retail food sector is dominated by three chains: PriceSmart (membership warehouse model, ~12 stores), Centro Cuesta Nacional (national supermarket chain, ~70 stores under Nacional and Jumbo banners), and Multi-Centro (regional chain, ~35 stores). All three import directly from the U.S. and Spain for branded goods; Centro Cuesta also sources fresh produce from Costa Rica and Colombia."

Correct extraction:
\`\`\`json
{
  "importers": [
    {
      "companyName": "PriceSmart",
      "roles": ["retailer", "importer"],
      "commodityCategories": ["food_processed"],
      "marketPosition": "major",
      "supplyPreferences": ["United States", "Spain"],
      "contextExcerpt": "The retail food sector is dominated by three chains: PriceSmart (membership warehouse model, ~12 stores). All three import directly from the U.S. and Spain for branded goods.",
      "confidence": 0.90
    },
    {
      "companyName": "Centro Cuesta Nacional",
      "roles": ["retailer", "importer", "distributor"],
      "commodityCategories": ["food_processed"],
      "marketPosition": "dominant",
      "supplyPreferences": ["United States", "Spain", "Costa Rica", "Colombia"],
      "contextExcerpt": "Centro Cuesta Nacional (national supermarket chain, ~70 stores under Nacional and Jumbo banners) imports directly from the U.S. and Spain for branded goods; Centro Cuesta also sources fresh produce from Costa Rica and Colombia.",
      "confidence": 0.95
    },
    {
      "companyName": "Multi-Centro",
      "roles": ["retailer", "importer"],
      "commodityCategories": ["food_processed"],
      "marketPosition": "major",
      "supplyPreferences": ["United States", "Spain"],
      "contextExcerpt": "Multi-Centro (regional chain, ~35 stores). All three import directly from the U.S. and Spain for branded goods.",
      "confidence": 0.85
    }
  ],
  "noNamedImporters": false,
  "sectionSummary": "Names the three dominant retail food chains with chain size + origin preferences."
}
\`\`\`

## Example 3 — Negative (statistical trade summary)

Section: "Agricultural imports by origin"
Source text:
"In 2025, the value of overall agricultural imports decreased by 15 percent to USD 2.5 billion, while volumes decreased by 5 percent to 4.5 million metric tons. The top suppliers by value were the United States (30 percent), Brazil (21 percent), and Colombia (13 percent). By volume, the United States held a 42 percent share, Brazil 23 percent, and Canada 15 percent. Imports made up about 60 percent of the country's total food supply in 2025."

Correct extraction:
\`\`\`json
{
  "importers": [],
  "noNamedImporters": true,
  "sectionSummary": "Country-level trade statistics by origin and category. No commercial counterparties named."
}
\`\`\`

The United States, Brazil, Colombia, and Canada are SUPPLIER COUNTRIES, not importing companies. Never extract them as importers.

# Failure modes to avoid

- Do not extract trade associations or chambers of commerce as importers.
- Do not aggregate multiple distinct mentions into a single "summary" row.
- Do not paraphrase the context excerpt — quote verbatim.
- Do not normalize company names (no "Empresas Polar" → "Polar"; no "Compañía X" → "X").
- Do not invent commodity categories the source did not explicitly tie to the company.
- If the same company is mentioned multiple times in the same section, emit ONE entry with the union of commodities + the most specific market position + the most informative context excerpt.

Now extract from the section text below.`;
}

/**
 * Per-section user message — the section text plus minimal context.
 */
export function gainSectionUserMessage(args: {
  reportTitle: string;
  reportType: string;
  countryCode: string;
  sectionTitle: string;
  sectionText: string;
}): string {
  return [
    `Report: ${args.reportTitle}`,
    `Report type: ${args.reportType}`,
    `Country (ISO-2): ${args.countryCode}`,
    `Section: ${args.sectionTitle}`,
    '',
    '--- BEGIN SECTION ---',
    args.sectionText,
    '--- END SECTION ---',
    '',
    'Extract per the schema. If the section is statistical / regulatory / contact info, set noNamedImporters: true and return empty importers.',
  ].join('\n');
}
