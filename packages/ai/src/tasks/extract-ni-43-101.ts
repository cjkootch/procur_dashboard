// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

/**
 * NI 43-101 mining technical report extraction.
 *
 * NI 43-101 is the Canadian regulatory standard for disclosure of
 * scientific and technical information about mineral projects on
 * SEDAR+ (TSX, TSX-V). Reports are filed under regulatory liability
 * — projections are technically validated by qualified persons.
 *
 * What we extract per buyer-intelligence-v2-free-sources-brief.md
 * §4.3:
 *   - Project + operator identification
 *   - Annual production schedule (forward-looking)
 *   - Direct annual fuel consumption volumes if disclosed
 *   - Fuel cost as % of opex / total opex (for derived volume)
 *   - Equipment fleet (haul truck count by class)
 *   - Section the data was extracted from (audit trail)
 *
 * Then the ingest script chooses the best derivation path:
 *   1. Direct annual_diesel_kl → bbl/yr at 0.90 confidence
 *   2. fuel_cost_usd_yr ÷ benchmark_diesel_price → bbl/yr at 0.65
 *   3. annual_production × intensity_factor → bbl/yr at 0.55
 */

export const NI43101Output = z
  .object({
    projectName: z.string().describe('Name of the mineral project (e.g. "Pueblo Viejo Mine").'),
    operatorName: z
      .string()
      .describe(
        'Name of the operating entity / issuer who filed the report. Often the parent ' +
          'company. e.g. "Barrick Gold Corporation", "Newmont Corporation".',
      ),
    projectCountryIso2: z
      .string()
      .nullable()
      .describe(
        'ISO-3166-1 alpha-2 country code where the project is located (e.g. "DO", ' +
          '"SR", "GY", "CA", "US"). Null if the report does not state the country.',
      ),
    reportTitle: z.string().describe('Full title of the technical report.'),
    reportEffectiveDate: z
      .string()
      .nullable()
      .describe(
        'ISO date (YYYY-MM-DD) of the report\'s effective date / data cutoff. Null if not found.',
      ),
    productionSchedule: z
      .array(
        z.object({
          year: z.number().int().describe('Calendar year (e.g. 2025).'),
          unit: z
            .enum(['oz_gold', 'oz_silver', 'tonnes_ore', 'tonnes_nickel', 'tonnes_copper', 'tonnes_iron', 'lb_copper', 'mt_alumina', 'kt_zinc', 'tonnes_lithium', 'other'])
            .describe('Unit of the production figure.'),
          value: z.number().describe('Expected production for the year.'),
        }),
      )
      .describe(
        'Forward production schedule years. Empty array if no schedule was extracted. ' +
          'Prefer the LOM (life-of-mine) schedule from the "Mine Plan" or "Production ' +
          'Schedule" section.',
      ),
    fuelConsumption: z
      .object({
        annualDieselKilolitres: z
          .number()
          .nullable()
          .describe('Annual diesel consumption in kL (= m³). Null if not directly disclosed.'),
        annualHfoKilolitres: z
          .number()
          .nullable()
          .describe('Annual HFO/heavy fuel consumption in kL. Null if not disclosed.'),
        fuelCostUsdYr: z
          .number()
          .nullable()
          .describe(
            'Annual fuel cost in USD. Null if not disclosed. Typically appears in the ' +
              '"Operating Cost" / "Opex" tables.',
          ),
        fuelCostPctOfOpex: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .describe(
            'Fuel as percentage of total operating cost (0-100). Null if not disclosed.',
          ),
        totalOpexUsdYr: z
          .number()
          .nullable()
          .describe(
            'Total annual operating cost (USD). Used with fuelCostPctOfOpex to derive ' +
              'fuel spend if fuelCostUsdYr was not directly disclosed.',
          ),
        haulTruckCount: z
          .number()
          .int()
          .nullable()
          .describe(
            'Total haul truck fleet count if disclosed in the equipment fleet section.',
          ),
        haulTruckClass: z
          .string()
          .nullable()
          .describe(
            'Truck class (e.g. "150-tonne", "240-tonne", "Cat 793") if disclosed. ' +
              'Null if not stated.',
          ),
      })
      .describe(
        'Fuel consumption / cost / fleet data. All fields nullable — we record what was ' +
          'found. The ingest script picks the best derivation path at signal-write time.',
      ),
    extractedFromSection: z
      .string()
      .describe(
        'Short name of the section the fuel data was extracted from (e.g. "Mine Plan", ' +
          '"Operating Costs", "Capital and Operating Costs", "Equipment Fleet"). Audit trail.',
      ),
    notes: z
      .string()
      .describe(
        'One short paragraph (under 400 chars) summarizing what was found, methodology, ' +
          'and any caveats the analyst should know. No filler.',
      ),
    caveats: z
      .array(z.string())
      .describe(
        'Specific caveats — e.g. "fuel volumes are forward projections, not historical", ' +
          '"diesel cost extracted from cost tables in 2024 USD". Empty array if none.',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        'Self-assessed confidence (0-1) that the extracted figures are accurate ' +
          'representations of the report\'s disclosures. 1.0 = direct disclosure with ' +
          'unambiguous units; 0.5 = inferred from cost tables; 0.3 = ambiguous / wide range.',
      ),
  })
  .strict();

export type NI43101OutputT = z.infer<typeof NI43101Output>;
export type NI43101ExtractResult = NI43101OutputT & { usage: CacheUsage };

/**
 * Run extraction over a single NI 43-101 report's plain text.
 * `reportText` should be the full document text (Sonnet 4.6's 1M
 * context window handles even 400+ page reports).
 */
export async function extractNI43101(
  reportText: string,
): Promise<NI43101ExtractResult> {
  const instruction = `You are a mining-sector financial analyst extracting structured data from an NI 43-101 technical report. The user has supplied the report text. Your job is to identify the project, operator, and any fuel-consumption-relevant data.

What you're hunting for, in priority order:
  1. Direct annual fuel volumes (diesel, HFO) — usually in "Energy and Fuel" or "Operating Costs" sections. Convert L → kL (1 kL = 1000 L); MWh and tonnes-of-fuel can be computed downstream so capture them in notes.
  2. Annual fuel cost (USD) — usually in operating-cost tables. The opex sub-line "Diesel" or "Fuel" is what we want.
  3. Fuel cost as % of opex + total opex — fallback when only the percentage is disclosed.
  4. Forward production schedule — annual production for the LOM (life-of-mine) section. Used for scale-based fuel derivation.
  5. Equipment fleet — haul truck count + class. Each class has a known L/operating-hour from industry benchmarks.

Rules:
  - All fuel fields are nullable. Set null when the report doesn't disclose. NEVER guess.
  - Forward-projecting schedules are common — capture them as-is. The ingest pipeline knows projections vs. historical.
  - Capture units faithfully: 'L', 'kL', 'm³', 'gallons US/IMP'. Conversions happen downstream.
  - Operator names go in their full legal form when given (e.g. "Barrick Gold Corporation"), not abbreviations.
  - Country codes — ISO-2. "Dominican Republic" → "DO", "Suriname" → "SR".
  - extractedFromSection should name the actual section as-printed in the report.
  - confidence — be honest. If the data is ambiguous or you had to interpret heavily, keep it under 0.6.

If the report is NOT an NI 43-101-style document (no fuel content, wrong format, scanned/empty text), set fuelConsumption fields to null, set confidence to 0.0, and explain in notes.`;

  const client = getClient();
  // Cache the report text in the system prompt — re-running extraction
  // (e.g. with a tweaked schema) hits cache, saves ~10x the cost.
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: buildSystem(instruction, reportText),
    messages: [
      {
        role: 'user',
        content:
          'Extract per the schema. Be strict about nullability — empty / not-disclosed → null.',
      },
    ],
    output_config: { format: zodOutputFormat(NI43101Output) },
  });

  if (!response.parsed_output) throw new Error('extract-ni-43-101: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
