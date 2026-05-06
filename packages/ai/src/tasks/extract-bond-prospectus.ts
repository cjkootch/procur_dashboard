// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

/**
 * Bond prospectus + continuing disclosure extraction.
 *
 * Per buyer-intelligence-v2-free-sources-brief.md §4.1, LatAm and
 * Caribbean industrial issuers file bond prospectuses with stock
 * exchanges (Luxembourg, Singapore, Bermuda, Cayman, EMMA, EDGAR,
 * CVM Brazil, CNV Argentina). These filings are the most reliable
 * disclosures available — they're filed under legal liability with
 * 5-10 year operational projections, segment-level cost breakdowns,
 * and fuel hedging programs.
 *
 * Shape differs from NI 43-101:
 *   - One ISSUER, often multiple operating SEGMENTS (e.g. Cementos
 *     Argos has cement Colombia + cement DR + cement Honduras
 *     segments); each can carry its own fuel data.
 *   - Hedging program disclosure is unique to bond filings (NI
 *     43-101 doesn't have it).
 *   - Forward projection horizon is longer (5-10y vs LOM mine plan).
 *
 * Confidence weights per the brief:
 *   - 0.85 for direct disclosure
 *   - 0.65 for derived from segment-level expenditure
 *
 * Sections to focus extraction on: "Risk Factors", "Operating and
 * Financial Review", "Industry", "Description of Business", and any
 * "Hedging" / "Risk Management" sub-sections.
 */

export const BondProspectusOutput = z
  .object({
    issuerName: z
      .string()
      .describe(
        'Full legal name of the issuing entity (e.g. "AES Dominicana Energía, S.A."). ' +
          'NOT the parent company unless the parent is the actual issuer.',
      ),
    issuerCountryIso2: z
      .string()
      .nullable()
      .describe(
        'ISO-3166-1 alpha-2 country of incorporation (e.g. "DO", "JM", "CO"). Null if not stated.',
      ),
    prospectusType: z
      .enum([
        'eurobond',
        'global_notes',
        'continuing_disclosure',
        'private_placement',
        'rule_144a',
        'reg_s',
        'sukuk',
        'other',
      ])
      .describe('Type of filing.'),
    filingExchange: z
      .string()
      .describe(
        'Exchange or system the prospectus was filed with — e.g. "Luxembourg Stock Exchange", ' +
          '"MSRB EMMA", "SEC EDGAR", "Bermuda Stock Exchange", "CVM Brazil".',
      ),
    filingDate: z
      .string()
      .nullable()
      .describe('ISO date (YYYY-MM-DD) of the prospectus / continuing-disclosure date. Null if not found.'),

    segments: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              'Segment label as the prospectus calls it (e.g. "Cement Caribbean", ' +
                '"Mining — Bauxite", "Power Generation", "Refining").',
            ),
          countryIso2: z
            .string()
            .nullable()
            .describe(
              'ISO-2 country of the segment. Null if multi-country / regional / not stated.',
            ),
          productionScaleUnit: z
            .enum([
              'mt_cement',
              'tonnes_alumina',
              'oz_gold',
              'tonnes_ore',
              'tonnes_steel',
              'mwh_generated',
              'bbl_throughput',
              'tonnes_lng',
              'tonnes_polymers',
              'flight_hours',
              'occupied_room_nights',
              'other',
            ])
            .nullable()
            .describe('Operating scale unit. Null if no scale figure given.'),
          annualProductionValue: z
            .number()
            .nullable()
            .describe(
              'Annual production / output figure in productionScaleUnit. Null if not disclosed.',
            ),
          annualDieselKilolitres: z
            .number()
            .nullable()
            .describe('Annual diesel consumption (kL = m³). Null if not disclosed.'),
          annualHfoKilolitres: z
            .number()
            .nullable()
            .describe('Annual HFO / heavy fuel consumption (kL). Null if not disclosed.'),
          annualNaturalGasMmBtu: z
            .number()
            .nullable()
            .describe(
              'Annual natural gas consumption (MMBtu). Null if not disclosed. ' +
                'Captured but not converted to bbl — gas is not a procur sales target.',
            ),
          annualFuelCostUsd: z
            .number()
            .nullable()
            .describe('Annual fuel cost in USD. Null if not disclosed.'),
          fuelCostPctOfOpex: z
            .number()
            .min(0)
            .max(100)
            .nullable()
            .describe('Fuel as % of total operating cost (0-100). Null if not disclosed.'),
          totalSegmentOpexUsd: z
            .number()
            .nullable()
            .describe('Total annual segment opex in USD. Null if not disclosed.'),
        }),
      )
      .describe(
        'One entry per operating segment with fuel data. Single-segment issuers should ' +
          'have exactly one entry. Skip segments without any fuel-relevant data.',
      ),

    fuelHedging: z
      .object({
        hasHedgingProgram: z
          .boolean()
          .describe(
            'True if the prospectus discloses an active fuel hedging program ' +
              '(swaps, forwards, options, fixed-price contracts).',
          ),
        hedgedVolumeKilolitresPerYr: z
          .number()
          .nullable()
          .describe(
            'Notional annual volume hedged (kL). Null if not disclosed quantitatively.',
          ),
        hedgeHorizonYears: z
          .number()
          .nullable()
          .describe('Forward horizon of the hedging program in years. Null if not stated.'),
        hedgeNotes: z
          .string()
          .nullable()
          .describe(
            'One-sentence summary of hedging instruments + counterparties + rationale ' +
              'as disclosed. Null if no hedging program.',
          ),
      })
      .nullable()
      .describe('Fuel hedging program disclosure. Null if no fuel hedging is mentioned.'),

    riskFactorSummary: z
      .string()
      .describe(
        'One-paragraph (under 600 chars) summary of the fuel-related risk-factor language. ' +
          'Quotes or paraphrases the issuer\'s own framing of fuel exposure / availability / ' +
          'price risk. Empty string if no fuel risk factor.',
      ),

    extractedFromSections: z
      .array(z.string())
      .describe(
        'Names of the sections the fuel data was extracted from (e.g. ' +
          '["Operating and Financial Review", "Risk Factors", "Hedging"]). Audit trail.',
      ),

    notes: z
      .string()
      .describe(
        'One short paragraph (under 400 chars) summarizing what was found. ' +
          'No filler.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        'Specific caveats the analyst should know (e.g. "fuel volumes are forward ' +
          'projections", "segment opex disclosed only for 2023; 2024-26 are guidance"). ' +
          'Empty array if none.',
      ),

    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        'Self-assessed confidence (0-1) that the extracted figures are accurate. ' +
          '0.85 typical for direct fuel-volume disclosure; 0.65 for opex-derived; ' +
          '0.3 for ambiguous / wide range.',
      ),
  })
  .strict();

export type BondProspectusOutputT = z.infer<typeof BondProspectusOutput>;
export type BondProspectusExtractResult = BondProspectusOutputT & { usage: CacheUsage };

export async function extractBondProspectus(
  reportText: string,
): Promise<BondProspectusExtractResult> {
  const instruction = `You are a credit / commodities analyst extracting structured fuel-consumption data from a bond prospectus, offering memorandum, or continuing-disclosure filing. The user has supplied the document text. Bond filings are filed under legal liability — the disclosures are the most reliable a public investor sees.

What you're hunting for, in priority order:
  1. Operating segment fuel volumes — usually in the "Operating and Financial Review" section. Often reported as "fuel costs" or "energy costs" with notes on fuel mix.
  2. Annual fuel cost (USD) per segment — from the segment-cost breakdowns. Critical fallback when fuel volumes aren't directly disclosed.
  3. Fuel hedging program — usually in "Risk Factors" or a dedicated "Hedging" / "Risk Management" sub-section. Notional hedged volumes, instrument types, counterparties, horizon.
  4. Risk factor language on fuel cost / availability — captures the issuer's own framing of fuel exposure.
  5. Forward projections (5-10y) — only capture if production schedule is given as numbers, not narrative.

Sections that typically carry fuel data:
  - "Risk Factors" — fuel cost exposure, hedging, availability
  - "Operating and Financial Review" or "Management's Discussion" — segment-level opex breakdowns
  - "Industry" — context on fuel intensity in the issuer's segment
  - "Description of Business" — fuel mix, generation profile (for utilities)
  - "Use of Proceeds" — sometimes mentions energy infrastructure capex that signals consumption

Rules:
  - All fuel fields are nullable. Set null when the prospectus doesn't disclose. NEVER guess.
  - Multi-segment issuers — one entry per fuel-relevant segment. Skip segments with no fuel data.
  - issuerName: full legal form (e.g. "AES Dominicana Energía, S.A."). Don't abbreviate.
  - countryIso2: ISO-2. "Dominican Republic" → "DO". Null if not stated.
  - Hedging: capture even when the program is qualitative (no notional volumes). Set hedgedVolumeKilolitresPerYr null in that case.
  - extractedFromSections: list the actual section names as printed.
  - confidence: be honest. 0.85 for direct fuel-volume disclosure with clean units; 0.65 for opex-derived; under 0.5 for ambiguous.

If the document is NOT a bond prospectus / continuing-disclosure filing (wrong format, scanned with no text, no fuel content), set segments to [], fuelHedging to null, confidence to 0.0, and explain in notes.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 6144,
    system: buildSystem(instruction, reportText),
    messages: [
      {
        role: 'user',
        content:
          'Extract per the schema. Be strict about nullability — empty / not-disclosed → null.',
      },
    ],
    output_config: { format: zodOutputFormat(BondProspectusOutput) },
  });

  if (!response.parsed_output) throw new Error('extract-bond-prospectus: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
