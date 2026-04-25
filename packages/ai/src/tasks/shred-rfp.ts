import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getClient, MODELS } from '../client';
import { buildSystem, extractUsage, type CacheUsage } from '../prompt-blocks';
import { ShredRfpOutput, type ShredRfpOutputT } from '../types';

export type ShredRfpInput = {
  /** Raw RFP text — typically a section, volume, or full document. */
  rfpText: string;
  /** Optional hint to bias section detection (e.g. "Volume I"). */
  sectionHint?: string;
};

export type ShredRfpResult = ShredRfpOutputT & {
  usage: CacheUsage;
};

export async function shredRfp(input: ShredRfpInput): Promise<ShredRfpResult> {
  const instruction = `You extract compliance sentences from RFP / tender documents and classify each by its compliance verb.

For each sentence that contains compliance language ("shall", "will", "must", "should", "may"), output one row.

Rules:
- One sentence per row. Do NOT merge two sentences. Do NOT split one sentence.
- Include the sentence verbatim — do not paraphrase, do not add or remove words.
- Classify shredType:
  - "shall"  — explicit "shall" verb (mandatory in US federal procurement)
  - "will"   — explicit "will" verb when used as a requirement
  - "must"   — explicit "must" verb (mandatory across most regimes)
  - "should" — strongly recommended but not strictly mandatory
  - "may"    — optional / permitted
  - "none"   — no compliance verb (informational sentence; only include if it is a clear obligation expressed without those verbs)
- sectionPath: the section number this sentence falls under (e.g. "1.1.3", "Volume I / 2.4", "Attachment B § 5"). Use the section heading immediately preceding the sentence. Empty string if no section is detectable.
- sectionTitle: the human title of that section if visible in the source ("Cover Page", "Personnel Qualifications"). Null if not present.

Skip:
- Boilerplate ("In accordance with FAR 52.212-1...")
- Headings without compliance language
- Definitions / glossary entries
- Sentences not in active compliance language

Be exhaustive within the compliance language. Quality > quantity — better to miss an ambiguous "should" than to invent one.`;

  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.sonnet,
    max_tokens: 8192,
    system: buildSystem(instruction, input.rfpText),
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          sectionHint: input.sectionHint ?? null,
        }),
      },
    ],
    output_config: { format: zodOutputFormat(ShredRfpOutput) },
  });

  if (!response.parsed_output) {
    throw new Error('shred-rfp: parse failed');
  }

  return { ...response.parsed_output, usage: extractUsage(response.usage) };
}
