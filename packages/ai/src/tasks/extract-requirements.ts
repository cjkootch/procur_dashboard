import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { ExtractRequirementsOutput, type ExtractRequirementsOutputT } from '../types';

export type ExtractRequirementsInput = {
  title: string;
  description?: string;
  /** Full tender document text — required for meaningful extraction. */
  docText: string;
};

export type ExtractRequirementsResult = ExtractRequirementsOutputT & {
  usage: CacheUsage;
};

export async function extractRequirements(
  input: ExtractRequirementsInput,
): Promise<ExtractRequirementsResult> {
  const instruction = `You extract structured requirements from government tender documents for bid qualification analysis.

Extract three things:

1. **requirements** — every concrete requirement a bidder must satisfy. Classify each as:
   - technical: product specs, performance criteria, methodology
   - financial: bid bond, financial capacity, turnover thresholds
   - legal: registrations, licenses, tax clearance
   - compliance: certifications, ISO/industry standards, local content rules
   - experience: years in business, past similar work, references
   Mark mandatory=true only if the document explicitly requires it for bid validity.
   sourceSection should name the heading/clause (e.g. "Section 3.2 — Technical Requirements").

2. **criteria** — evaluation/award criteria with weights if stated. If no weights are given, use 0.

3. **mandatoryDocuments** — the list of documents bidders must submit (e.g. "Certificate of Incorporation", "Audited Financial Statements 2023-2024", "Tax Compliance Certificate").

4. **confidence** — 0-1 overall, reflecting how complete and structured the source document was.

Be exhaustive but accurate. Do not invent requirements that are not in the document.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 8192,
    system: buildSystem(instruction, input.docText),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          title: input.title,
          description: input.description ?? null,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ExtractRequirementsOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('extract-requirements: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
