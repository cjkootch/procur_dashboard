// Schemas consumed by zodOutputFormat MUST be Zod 4 — see ../zod-output.ts.
import { z } from 'zod/v4';

/**
 * Structured-output schema for MDB per-section extraction.
 *
 * Mirrors the GAIN extraction schema shape but with MDB-specific
 * vocabulary: roles target procurement / loan agreements
 * (borrower / contractor / supplier / consultant) rather than the
 * food-distribution chain GAIN tracks. Sector taxonomy aligns with
 * how MDBs classify projects (energy / infrastructure / water /
 * transport / etc.).
 *
 * The explicit `noNamedCounterparties` flag mirrors GAIN's
 * `noNamedImporters` — gives the model a structured way to say
 * "this section is preamble / safeguards / annex / etc." without
 * forcing low-confidence guesses.
 */

export const MdbEntityRole = z.enum([
  'borrower',
  'implementing_agency',
  'executing_agency',
  'contractor',
  'subcontractor',
  'supplier',
  'consultant',
  'technical_advisor',
  'financier',
  'co_financier',
  'guarantor',
  'beneficiary',
  'other',
]);
export type MdbEntityRoleT = z.infer<typeof MdbEntityRole>;

/**
 * Sector taxonomy for MDB-funded work. Closely tracks how IDB / World
 * Bank / IFC classify their portfolios. 'other' is the escape hatch.
 */
export const MdbSector = z.enum([
  'energy',
  'power_generation',
  'oil_and_gas',
  'mining',
  'transport',
  'ports_and_logistics',
  'water_and_sanitation',
  'agriculture',
  'agribusiness',
  'food_processing',
  'manufacturing',
  'financial_services',
  'telecommunications',
  'health',
  'education',
  'housing',
  'urban_development',
  'tourism',
  'environment',
  'public_sector_reform',
  'other',
]);
export type MdbSectorT = z.infer<typeof MdbSector>;

export const MdbNamedEntity = z
  .object({
    companyName: z
      .string()
      .min(2)
      .describe(
        'Verbatim legal or trade name as written in the source. Preserve ' +
          'corporate suffixes (S.A., C.A., Ltda., Inc., Corp., Pte. Ltd.) ' +
          'and accents. Do NOT translate or normalize.',
      ),
    roles: z
      .array(MdbEntityRole)
      .min(1)
      .describe(
        'One or more roles played in this project. Use multi-role tags ' +
          'when a single company plays e.g. both contractor AND supplier.',
      ),
    sector: MdbSector.describe(
      'Sector classification. Use the closest controlled-vocabulary value; ' +
        'pick `other` only when no listed sector fits.',
    ),
    contractValueUsd: z
      .number()
      .nullable()
      .describe(
        'Awarded contract value in USD when published verbatim in the source. ' +
          'Convert from local currency ONLY when an explicit FX rate is also ' +
          'published in the same section. NULL when not disclosed or when the ' +
          'entity is named without per-contract figures (borrower, agency).',
      ),
    contextExcerpt: z
      .string()
      .min(20)
      .describe(
        '1-3 sentences from the source giving the context for this mention. ' +
          'Quote verbatim — no paraphrase, no summary.',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        'Self-rated 0-1 on whether this is a genuine commercial counterparty ' +
          'mention. 0.85+ for an explicit role-named contractor / supplier; ' +
          '0.65-0.84 for less direct mentions; below 0.5 should rarely be returned.',
      ),
  })
  .strict();
export type MdbNamedEntityT = z.infer<typeof MdbNamedEntity>;

export const MdbExtractionOutput = z
  .object({
    entities: z
      .array(MdbNamedEntity)
      .describe(
        'Empty array when the section contains no named commercial ' +
          'counterparties (preamble, safeguards, project rationale, annexes, ' +
          'environmental/social review, references). NEVER invent names.',
      ),
    noNamedCounterparties: z
      .boolean()
      .describe(
        'Set true when the section text contains preamble / rationale / ' +
          'safeguards / regulatory text / references WITHOUT naming specific ' +
          'commercial counterparties. Forces an empty `entities` array. ' +
          'Country names ("Jamaica", "Dominican Republic") are sovereign ' +
          'borrowers ONLY when explicitly identified as the receiving ' +
          'government — never as commercial counterparties otherwise.',
      ),
    sectionSummary: z
      .string()
      .max(400)
      .describe(
        'One sentence under 400 chars summarizing what the section was about. ' +
          'For audit / debugging.',
      ),
  })
  .strict();
export type MdbExtractionOutputT = z.infer<typeof MdbExtractionOutput>;
