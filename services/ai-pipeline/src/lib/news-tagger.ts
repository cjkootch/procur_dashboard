import { getClient, MODELS } from '@procur/ai';

/**
 * Classify a single news item against the procur entity universe.
 * Tags it with:
 *   - eventType: structured taxonomy (matches entity_news_events)
 *   - entityNames: free-text mentions (later resolved to slugs by SQL)
 *   - relevanceScore: 0.0–1.0 (below 0.4 = noise, drop)
 *
 * Single Haiku call per item, ~$0.0001 each at 4.5 pricing. Cheap
 * enough to run on every fetched item without batching.
 */
export type NewsTaggerInput = {
  /** Curated list of names from known_entities the feed might
   *  reference. Helps Haiku narrow on entities procur tracks rather
   *  than emitting random company mentions. Send a tight set
   *  (200-500 names max). */
  candidateEntityNames: string[];
  title: string;
  summary: string;
  source: string;
};

export type NewsTaggerOutput = {
  eventType: NewsEventType;
  entityNames: string[];
  /** 0.0–1.0. <0.4 means "we mention an entity but the article is
   *  generic"; ≥0.7 means "this is materially about a procur entity". */
  relevanceScore: number;
  /** A 1-2 sentence summary normalized to procur's voice. */
  normalizedSummary: string;
};

export const NEWS_EVENT_TYPES = [
  'refinery_outage',
  'refinery_turnaround',
  'sanctions_action',
  'bankruptcy_filing',
  'leadership_change',
  'force_majeure',
  'pipeline_disruption',
  'port_disruption',
  'mna_announcement',
  'capacity_change',
  'price_event',
  'press_distress_signal',
  'general_news',
] as const;
export type NewsEventType = (typeof NEWS_EVENT_TYPES)[number];

const SYSTEM = `You classify energy / fuel-trading news items for procur.

Return ONLY valid JSON matching this shape — no preamble, no markdown:
{
  "eventType": "<one of the allowed types>",
  "entityNames": ["<name from the candidate list, exact match>", ...],
  "relevanceScore": <0.0-1.0>,
  "normalizedSummary": "<1-2 short sentences>"
}

Allowed eventType values:
  refinery_outage         — unplanned refinery shutdown, fire, accident
  refinery_turnaround     — planned maintenance window
  sanctions_action        — OFAC / EU / UK sanctions on a company or grade
  bankruptcy_filing       — Ch.11/15, administration, liquidation
  leadership_change       — CEO/board/trading-head moves
  force_majeure           — cargo / contract force-majeure declarations
  pipeline_disruption     — pipeline outage, leak, sabotage
  port_disruption         — port / canal closures, draft restrictions
  mna_announcement        — acquisitions, divestments, JV formation
  capacity_change         — refinery capacity expansion / cut, new units
  price_event             — major price moves with named drivers
  press_distress_signal   — reported financial distress short of bankruptcy
  general_news            — material commercial news that doesn't fit above

entityNames discipline:
  - Match VERBATIM against the candidate list (case-sensitive). If
    the article says "Vitol" and the candidate list has "Vitol",
    include "Vitol". If the article says "Vitol Group" but the
    candidate has "Vitol", still emit "Vitol" — match the candidate
    spelling, not the article spelling.
  - DO NOT invent entity names not in the list. Empty array is fine.
  - Multiple mentions are fine; cap at 5 entries.

relevanceScore discipline:
  - 0.0-0.3: article doesn't mention any candidate entity, or
    mentions one only in passing.
  - 0.4-0.6: candidate entity is mentioned but article is more about
    the broader market.
  - 0.7-1.0: article is materially about a candidate entity (their
    refinery had an outage, their CEO resigned, they declared force
    majeure on a cargo, etc.)

normalizedSummary: 1-2 sentences, third person, factual, no editorializing.`;

export async function tagNewsItem(
  input: NewsTaggerInput,
): Promise<NewsTaggerOutput | null> {
  const client = getClient();

  const userMessage = [
    `Source: ${input.source}`,
    `Title: ${input.title}`,
    `Summary: ${input.summary || '(none)'}`,
    '',
    `Candidate entity names (only emit names from this list, verbatim):`,
    input.candidateEntityNames.slice(0, 500).join(', ') || '(none)',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch {
    return null;
  }

  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return null;

  let parsed: unknown;
  try {
    // Tolerate accidental code-fence wrapping.
    const cleaned = block.text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const eventType = (NEWS_EVENT_TYPES as readonly string[]).includes(
    String(p.eventType),
  )
    ? (p.eventType as NewsEventType)
    : 'general_news';
  const entityNames = Array.isArray(p.entityNames)
    ? (p.entityNames as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .filter((name) => input.candidateEntityNames.includes(name))
        .slice(0, 5)
    : [];
  const score = typeof p.relevanceScore === 'number' ? p.relevanceScore : 0;
  const relevanceScore = Math.max(0, Math.min(1, score));
  const normalizedSummary =
    typeof p.normalizedSummary === 'string'
      ? p.normalizedSummary.slice(0, 600)
      : input.summary.slice(0, 400);

  return { eventType, entityNames, relevanceScore, normalizedSummary };
}
