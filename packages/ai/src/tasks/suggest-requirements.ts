import { zodOutputFormat } from '../zod-output';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { SuggestRequirementsOutput, type SuggestRequirementsOutputT } from '../types';

export type SuggestRequirementsInput = {
  /** Tender title — keep short, used as system context. */
  opportunityTitle: string;
  /** Tender description / scope statement. The longer + more
      structured this is, the better the extraction. */
  opportunityDescription: string | null;
  /** Optional already-extracted requirements blob — when present, AI
      is asked to extend rather than re-derive from scratch. */
  existingRequirementsHint?: string;
  /** Company capability bank: id + name + (optional) description.
      Passed in so the AI can map suggested requirements to existing
      capabilities and surface clear gaps. */
  capabilities: Array<{
    id: string;
    name: string;
    category: string;
    description?: string | null;
  }>;
};

export type SuggestRequirementsResult = SuggestRequirementsOutputT & {
  usage: CacheUsage;
};

/**
 * Reads an opportunity's title + description and proposes the
 * capability-matrix requirements: the things a bidder must / should /
 * could satisfy, mapped to the company's capability bank.
 *
 * Output:
 *   - requirements[]   — one row per concrete requirement
 *   - confidence       — overall extraction confidence
 *
 * Design rationale:
 *   - We feed the company's capability bank into the prompt so the
 *     model can name a `suggestedCapabilityId` directly. This avoids
 *     a second "match requirements to capabilities" pass.
 *   - Coverage status is the model's call: 'covered' / 'partial' /
 *     'gap' / 'not_assessed'. The UI can show 'gap' rows in red as
 *     teaming triggers.
 *   - We DON'T look at extracted shreds (sentence-level shall/will/
 *     must). Shreds are about compliance language; capability
 *     requirements are about "what does the bidder need to be able
 *     to do?" — different abstraction level.
 */
export async function suggestRequirements(
  input: SuggestRequirementsInput,
): Promise<SuggestRequirementsResult> {
  const instruction = `You read government tender / RFP descriptions and propose the capability-matrix requirements a bidder needs to satisfy.

For each concrete requirement you find, return one row with:
  - requirement: a noun phrase or short sentence stating what the bidder must do or have. Avoid restating the entire RFP language; distill to one obligation per row.
  - priority: must (bid-killer if missing), should (strongly evaluated), nice (bonus).
  - suggestedCapabilityId: pick from the supplied capabilities[] when one is a clear match, else null. Match on intent, not just keyword.
  - coverage: 'covered' if you can confidently match a capability that fulfills the requirement; 'partial' if a capability is adjacent (e.g. "ISO 9001" exists, requirement asks for "ISO 27001" — same family); 'gap' if no capability in the bank addresses it; 'not_assessed' if the requirement is too ambiguous to map.
  - rationale: one sentence explaining the extraction + mapping decision, or null when obvious.

Be exhaustive but targeted. Don't generate "evaluation criteria" rows (those go in a separate flow). Don't restate boilerplate ("submit your bid by the deadline"). Skip requirements you'd consider universal (vendor must be incorporated). Prioritize the requirements that distinguish bidders.

If the description is empty or has no concrete requirements, return an empty list with low confidence — don't invent.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 4096,
    system: buildSystem(instruction, input.opportunityDescription ?? ''),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          opportunityTitle: input.opportunityTitle,
          existingRequirementsHint: input.existingRequirementsHint ?? null,
          capabilities: input.capabilities,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(SuggestRequirementsOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('suggest-requirements: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
