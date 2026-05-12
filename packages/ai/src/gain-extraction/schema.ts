// Schemas consumed by zodOutputFormat MUST be Zod 4 — see ../zod-output.ts.
import { z } from 'zod/v4';

/**
 * Structured-output schema for GAIN per-section extraction.
 *
 * Per docs/gain-extraction-brief.md §4. The model is asked, per
 * candidate section, to either:
 *   (a) name commercial counterparties with provenance, OR
 *   (b) signal `noNamedImporters: true` and return an empty list.
 *
 * The explicit `noNamedImporters` flag gives the model a structured
 * way to say "I saw no commercial counterparties" rather than
 * feeling forced to produce something — directly addresses the
 * negative-case validation requirement (§4.3 quality controls).
 */

export const GainImporterRole = z.enum([
  'importer',
  'distributor',
  'wholesaler',
  'retailer',
  'food_service',
  'miller',
  'refiner',
  'integrator',
  'processor',
  'producer',
  'other',
]);
export type GainImporterRoleT = z.infer<typeof GainImporterRole>;

/**
 * Commodity-category controlled vocabulary aligned with HS chapters
 * the GAIN reports cover. 'other' is the escape hatch for niche
 * commodities the LLM shouldn't force into a major bucket.
 */
export const GainCommodityCategory = z.enum([
  'wheat',
  'corn',
  'soybean',
  'soybean_oil',
  'soybean_meal',
  'rice',
  'sugar',
  'beef',
  'pork',
  'poultry',
  'dairy',
  'oilseeds_other',
  'sorghum',
  'barley',
  'cotton',
  'coffee',
  'cocoa',
  'tobacco',
  'cassava',
  'palm_oil',
  'feed',
  'pulses',
  'tree_nuts',
  'fish_seafood',
  'food_processed',
  'fertilizer',
  'other',
]);
export type GainCommodityCategoryT = z.infer<typeof GainCommodityCategory>;

export const GainMarketPosition = z.enum([
  'dominant',
  'major',
  'emerging',
  'declining',
  'unknown',
]);
export type GainMarketPositionT = z.infer<typeof GainMarketPosition>;

export const GainNamedImporter = z
  .object({
    companyName: z
      .string()
      .min(2)
      .describe(
        'Verbatim legal or trade name as written in the source. Preserve ' +
          'accents, capitalization, and corporate suffixes (S.A., C.A., ' +
          'Ltda.). Do NOT translate or normalize.',
      ),
    roles: z
      .array(GainImporterRole)
      .min(1)
      .describe(
        'One or more business roles played by this company. ' +
          'Use multi-role tags when USDA describes the company as e.g. ' +
          'both miller AND distributor.',
      ),
    commodityCategories: z
      .array(GainCommodityCategory)
      .min(1)
      .describe(
        'Commodity categories the company is named in. Use the closest ' +
          'controlled-vocabulary value; pick `other` only when no listed ' +
          'category fits.',
      ),
    marketPosition: GainMarketPosition.describe(
      'USDA\'s stated assessment of the company\'s position. Use ' +
        '`unknown` when the source does not characterize.',
    ),
    supplyPreferences: z
      .array(z.string())
      .describe(
        'Countries / regions USDA notes the company prefers to source from. ' +
          'Verbatim country names from the source ("United States", ' +
          '"Brazil", "Argentina"). Empty array when not mentioned.',
      ),
    contextExcerpt: z
      .string()
      .min(20)
      .describe(
        '1-3 sentences from the source giving the context for this ' +
          'mention. Quote verbatim — no paraphrase, no summary.',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        'Self-rated 0-1 on whether this is a genuine commercial ' +
          'counterparty mention vs. a passing reference. 0.85+ for a ' +
          'company described as an importer / distributor by name; 0.6-0.8 ' +
          'for a less direct mention; below 0.5 should rarely be returned.',
      ),
  })
  .strict();
export type GainNamedImporterT = z.infer<typeof GainNamedImporter>;

export const GainExtractionOutput = z
  .object({
    importers: z
      .array(GainNamedImporter)
      .describe(
        'Empty array when the section contains no named commercial ' +
          'counterparties (e.g. macro statistics, regulatory text, country-' +
          'level trade tables). NEVER invent names; only extract verbatim ' +
          'mentions.',
      ),
    noNamedImporters: z
      .boolean()
      .describe(
        'Set true when the section text contains macro statistics, country ' +
          '/ category breakdowns, or regulatory content WITHOUT naming ' +
          'specific commercial counterparties. Forces an empty `importers` ' +
          'array. This is the structured way to say "I saw no commercial ' +
          'counterparties here" — use it rather than producing low-confidence ' +
          'guesses from trade-data tables.',
      ),
    sectionSummary: z
      .string()
      .max(400)
      .describe(
        'One sentence under 400 chars summarizing what the section was ' +
          'about. For audit / debugging.',
      ),
  })
  .strict();
export type GainExtractionOutputT = z.infer<typeof GainExtractionOutput>;
