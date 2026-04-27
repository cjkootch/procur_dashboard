// Schemas consumed by zodOutputFormat MUST be Zod 4 — see types.ts.
import { z } from 'zod/v4';
import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';

export const ExtractPricingOutput = z
  .object({
    suggestedStrategy: z
      .enum(['labor_hours', 'firm_fixed_price', 'cost_plus', 'time_materials'])
      .describe('Best-fit pricing strategy given how the tender asks for pricing.'),
    reasoning: z.string().describe('One sentence on why this strategy fits.'),
    suggestedCurrency: z
      .string()
      .describe('ISO 4217 code of the currency the tender expects bids in (e.g., JMD, TTD, USD).'),
    basePeriodMonths: z
      .number()
      .int()
      .nullable()
      .describe('Stated base period length in months, null if not specified.'),
    optionYears: z
      .number()
      .int()
      .nullable()
      .describe('Number of option years the tender allows, null if none.'),
    requiredPricingDeliverables: z
      .array(z.string())
      .describe(
        'Pricing artifacts the tender requires — e.g. "Priced Bill of Quantities", "Labor rate schedule", "Monthly cash flow projection".',
      ),
    suggestedLaborCategories: z
      .array(
        z.object({
          title: z.string(),
          type: z.enum(['key_personnel', 'standard']),
        }),
      )
      .describe(
        'Key personnel or standard labor categories the tender explicitly or implicitly requires. Best-effort — may be empty.',
      ),
    indirectHints: z.object({
      fringeMentioned: z.boolean(),
      overheadMentioned: z.boolean(),
      gaMentioned: z.boolean(),
      notes: z.string(),
    }),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ExtractPricingOutputT = z.infer<typeof ExtractPricingOutput>;

export type ExtractPricingInput = {
  opportunity: {
    title: string;
    jurisdictionName: string;
    agencyName?: string | null;
    description?: string | null;
    referenceNumber?: string | null;
  };
  extractedRequirements: Array<{ type: string; text: string; mandatory: boolean }>;
  mandatoryDocuments: string[];
  /** Optional full tender document text for caching. */
  docText?: string;
};

export type ExtractPricingResult = ExtractPricingOutputT & { usage: CacheUsage };

export async function extractPricingStructure(
  input: ExtractPricingInput,
): Promise<ExtractPricingResult> {
  const financial = input.extractedRequirements.filter((r) => r.type === 'financial');

  const instruction = `You analyze government tender requirements to suggest a pricing structure.

Your output seeds a Pricer workbook — the user will adjust every value but needs a correct starting structure.

Rules:
- Pick ONE pricing strategy. Labor-hours fits when labor rates are the core deliverable (consulting, IT services). Firm fixed price fits when the tender asks for a single total price. Cost-plus fits when the tender mandates a fee on actuals. T&M fits when both labor rates and materials reimbursement are expected.
- Currency should match what the tender is denominated in (Caribbean and African tenders are usually local currency; multilateral-funded tenders often USD).
- Base period months and option years: lift straight from the tender if stated. Null if not mentioned.
- requiredPricingDeliverables: list the *pricing-related* artifacts only (priced BoQ, rate schedule, cash flow, bid bond amount, etc). Not "Certificate of Incorporation" type documents.
- suggestedLaborCategories: if the tender names specific roles (e.g. "Senior Engineer", "Project Manager"), include them. Type = key_personnel if the tender calls them out individually, otherwise standard. Leave empty if the tender is not labor-focused.
- indirectHints: whether the tender explicitly mentions fringe, overhead, or G&A accounting.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 2048,
    system: buildSystem(instruction, input.docText),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          opportunity: input.opportunity,
          financialRequirements: financial,
          mandatoryDocuments: input.mandatoryDocuments,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ExtractPricingOutput) },
  });

  if (!response.parsed_output) throw new Error('extract-pricing: parse failed');
  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
