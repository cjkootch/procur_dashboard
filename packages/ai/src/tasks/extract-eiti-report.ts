// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

/**
 * EITI country report extraction.
 *
 * Per buyer-intelligence-v2-free-sources-brief.md §4.5, EITI
 * (Extractive Industries Transparency Initiative) country reports
 * publish detailed annual reports with company-level production
 * data, government revenue data, and operational disclosures.
 *
 * Differs from NI 43-101 + bond prospectus in shape:
 *   - One report covers MANY companies (not one issuer / project)
 *   - Country-scoped (Trinidad and Tobago, Suriname, Guyana, DR,
 *     Mexico, Colombia, Peru, etc.)
 *   - Government revenue + payment reconciliation tables — useful
 *     as fuel-cost / opex proxies when direct disclosure is missing
 *   - Annual cycle, with reporting lag of 1-2 years
 *
 * Confidence weights per the brief:
 *   - 0.80 for directly disclosed company-level fuel consumption (rare)
 *   - 0.65 for derived from financial / government-revenue data
 *
 * Highest-leverage Caribbean coverage:
 *   - T&T EITI (tteiti.org.tt) — strong, includes detailed energy
 *     company financials
 *   - Suriname EITI — moderate, gold + oil sector
 *   - Guyana EITI — emerging, oil sector focus (ExxonMobil Stabroek
 *     block + co-venturers)
 *   - DR EITI — mining sector
 */

export const EITIReportOutput = z
  .object({
    reportTitle: z.string().describe('Full title of the EITI report.'),
    reportingCountryIso2: z
      .string()
      .nullable()
      .describe(
        'ISO-3166-1 alpha-2 of the country whose EITI body issued the report ' +
          '(e.g. "TT", "SR", "GY", "DO", "CO", "PE", "MX"). Null if unclear.',
      ),
    reportingYear: z
      .number()
      .int()
      .nullable()
      .describe('Calendar year the report covers (e.g. 2023). Null if not stated.'),
    publishedDate: z
      .string()
      .nullable()
      .describe('ISO date the report was published. Null if not found.'),

    companies: z
      .array(
        z.object({
          name: z
            .string()
            .describe(
              'Company name as it appears in the report. Use the legal form when ' +
                'given (e.g. "ExxonMobil Guyana Limited", "Petrotrin Limited").',
            ),
          sector: z
            .enum([
              'oil_gas_upstream',
              'oil_gas_downstream',
              'mining',
              'power_generation',
              'pipeline_midstream',
              'service_company',
              'other',
            ])
            .describe('Primary sector classification per the report.'),
          productionScaleUnit: z
            .enum([
              'bbl_oil',
              'mcf_gas',
              'mt_lng',
              'tonnes_ore',
              'oz_gold',
              'tonnes_alumina',
              'mwh_generated',
              'tonnes_coal',
              'other',
            ])
            .nullable()
            .describe('Operating scale unit (or null if not stated).'),
          annualProductionValue: z
            .number()
            .nullable()
            .describe('Annual production figure in productionScaleUnit. Null if not disclosed.'),

          annualDieselKilolitres: z
            .number()
            .nullable()
            .describe('Annual diesel consumption (kL). Null if not disclosed.'),
          annualHfoKilolitres: z
            .number()
            .nullable()
            .describe('Annual HFO consumption (kL). Null if not disclosed.'),
          annualFuelCostUsd: z
            .number()
            .nullable()
            .describe('Annual fuel cost (USD) if disclosed. Null otherwise.'),
          fuelCostPctOfOpex: z
            .number()
            .min(0)
            .max(100)
            .nullable()
            .describe('Fuel as % of opex (0-100). Null if not disclosed.'),
          totalCompanyOpexUsd: z
            .number()
            .nullable()
            .describe('Total annual opex (USD) for the company. Null if not disclosed.'),

          /** EITI reconciles company-disclosed payments against
           *  government-disclosed receipts; both numbers are useful as
           *  a fuel-spend / opex proxy when direct fuel data is
           *  missing.  This is the EITI's primary disclosure mode. */
          governmentPaymentsUsd: z
            .number()
            .nullable()
            .describe(
              'Total payments to government (royalties + taxes + fees) for the period (USD). ' +
                'EITI core reconciliation field. Null if not disclosed.',
            ),
        }),
      )
      .describe(
        'One entry per company in the report with at least sector + name. ' +
          'Skip companies with no relevant data. EITI reports vary widely — some ' +
          'cover only top-N producers, others include the long tail of service ' +
          'companies. Capture what\'s there.',
      ),

    extractedFromSections: z
      .array(z.string())
      .describe(
        'Section names the data was pulled from. EITI reports usually have ' +
          '"Reconciliation Tables", "Operations", "Production by Company", ' +
          '"Financial Disclosure" sub-sections.',
      ),
    notes: z.string().describe('One paragraph (under 400 chars) summary of what was found.'),
    caveats: z.array(z.string()).describe('Specific caveats; empty array if none.'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        '0-1 self-assessed. 0.80 typical for direct fuel-volume disclosure; 0.65 ' +
          'for opex-derived; under 0.5 for purely government-payment-proxy.',
      ),
  })
  .strict();

export type EITIReportOutputT = z.infer<typeof EITIReportOutput>;
export type EITIReportExtractResult = EITIReportOutputT & { usage: CacheUsage };

export async function extractEITIReport(
  reportText: string,
): Promise<EITIReportExtractResult> {
  const instruction = `You are a commodities + energy analyst extracting structured fuel-consumption + production data from an EITI (Extractive Industries Transparency Initiative) country report. The user has supplied the report text.

EITI country reports cover many companies in one document — extract data for every company that has at least sector + name. Empty fuel fields are normal; EITI reports primarily disclose government-revenue reconciliation, with fuel/energy data appearing only in countries where the EITI scope includes operational disclosures (T&T is strong; others vary).

What you're hunting for, per company entry:
  1. Direct annual fuel volumes — diesel + HFO in kL. Usually only present in detailed operational sections.
  2. Annual fuel cost (USD) — sometimes in opex breakdown tables.
  3. Production figures — bbl oil/yr, mcf gas/yr, mt LNG, tonnes ore, oz gold, etc.
  4. Government payments (USD) — EITI's core reconciliation field. Useful as opex proxy when direct fuel data is missing.
  5. Total company opex — when given alongside fuel-cost-as-%.

Sections to focus on:
  - "Reconciliation Tables" — government payment data
  - "Operations" / "Production by Company" — production figures
  - "Financial Disclosures" / "Operating Costs" — opex + fuel cost
  - "Energy Sector Overview" — sector context (T&T-style)

Rules:
  - All fuel fields nullable. Set null when not disclosed. NEVER guess.
  - Sector classification — pick the dominant. If ambiguous use 'other'.
  - reportingCountryIso2: ISO-2. "Trinidad and Tobago" → "TT", "Suriname" → "SR".
  - Skip companies in the report that have no data (just a name in a list) — extract is for fuel-relevant entries.
  - confidence: 0.80 for direct fuel volumes; 0.65 for opex-derived; under 0.5 for government-payment-only proxy.

If the document is NOT an EITI report (wrong format, scanned with no text), set companies to [], confidence to 0.0, and explain in notes.`;

  const client = getClient();
  // EITI reports are large — bump max_tokens to fit potentially many
  // companies in the structured output.
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 8192,
    system: buildSystem(instruction, reportText),
    messages: [
      {
        role: 'user',
        content:
          'Extract per the schema. Be strict about nullability — empty / not-disclosed → null.',
      },
    ],
    output_config: { format: zodOutputFormat(EITIReportOutput) },
  });

  if (!response.parsed_output) throw new Error('extract-eiti-report: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
