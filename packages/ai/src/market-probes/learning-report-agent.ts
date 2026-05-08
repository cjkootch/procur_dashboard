import { getClient, MODELS } from '../client';
import type { LearningReportPayload } from '@procur/db';

/**
 * End-of-probe Learning Report agent. Single Sonnet pass over
 * scorecard + atlas + hypotheses + feedback + segments → structured
 * synthesis the operator + future probes consume.
 *
 * The report's playbookUpdates + recommendedNextProbe nominations
 * feed the playbook generator (operator approves before any
 * playbook row gets created).
 */

export interface LearningReportContext {
  probeName: string;
  country: string | null;
  productThesis: string;
  ladderStage: string;
  durationDays: number;
  scorecard: {
    targetsTotal: number;
    sentCount: number;
    repliedCount: number;
    positiveReplies: number;
    bouncedCount: number;
    replyRate: number;
    routingRate: number;
    qualifiedInterestRate: number;
    bounceRate: number;
    atlasFactsCount: number;
    atlasNegativeRulesCount: number;
    hypothesesActive: number;
    hypothesesConfirmed: number;
    hypothesesFalsified: number;
    overallLearning: number;
  };
  hypotheses: Array<{
    hypothesisType: string;
    statement: string;
    status: string;
    confidenceStart: number;
    confidenceCurrent: number;
    result: string | null;
  }>;
  segments: Array<{
    name: string;
    estimatedTotal: number | null;
    identified: number;
    contacted: number;
    replied: number;
  }>;
  topSignals: Array<{
    signal: string;
    withSent: number;
    withReplied: number;
    withoutSent: number;
    withoutReplied: number;
    replyDelta: number;
  }>;
  atlasFacts: Array<{
    factType: string;
    description: string;
    ruleText: string | null;
  }>;
  feedbackShortcuts: Array<{
    label: string;
    sentiment: string;
    payload: Record<string, unknown>;
  }>;
  /** Confirmed-or-falsified hypotheses' results for the
   *  what-we-believed-vs-what-changed diff. */
  rejectedStrategyProposals: Array<{
    proposalType: string;
    rationale: string;
    feedback: string | null;
  }>;
  /** Cross-probe memory: prior learning reports in the same country.
   *  The agent synthesizes cumulative market wisdom rather than
   *  emitting an isolated report. When this is non-empty, the report
   *  should reference what changed since prior probes (e.g.
   *  "Confirms the segment ranking from probe #3 with new evidence
   *  at higher volume"). Empty when this is the country's first
   *  probe. */
  priorLearningReports?: Array<{
    probeName: string;
    generatedAt: string;
    summary: string;
    payloadDigest: string;
  }>;
}

export interface LearningReportResult {
  summary: string;
  payload: LearningReportPayload;
}

const SYSTEM_PROMPT = `You are the end-of-probe Learning Report agent for a Market Probe — a bounded autonomous market-prospecting experiment.

Your job: synthesize the probe's scorecard + atlas facts + hypotheses + signal-validation + feedback + segments into a single structured report. The operator reads this; the playbook generator reads this; future probes start smarter because of this.

Discipline:
- Ground every claim in the data given. "Hotels replied 2x more than fuel distributors" is grounded; "hotels are a strong segment" without numbers is not.
- For badTargetRules, propose CONCRETE prescriptive rules ("never target generic info@ inboxes for fuel distributors in BB"). These ride into the atlas as negative_rule facts after operator approval.
- For recommendedNextProbe, suggest a SPECIFIC next experiment — country + 2-4 segments + 2-3 hypotheses to test. Don't just say "explore Bahamas"; say "Bahamas hotel procurement, hypothesis: hotels source from regional distributor LBR Foods."
- For playbookUpdates, only nominate fields the data supports. If contact-title evidence is thin, leave bestContactTitles empty.
- HONOR cross-probe memory. When prior learning reports in this country exist, your report must SYNTHESIZE — reference what changed since the prior reports (confirmation, contradiction, new ground covered) rather than emitting an isolated take. When the prior reports already learned something this probe re-confirmed, say "this probe confirms probe X's finding that ..." instead of presenting it as new. The recommendedNextProbe in particular should NOT repeat segments / hypotheses tried in the prior reports.

Output a single JSON object matching this shape (omit any field with no grounded evidence):
{
  "summary": "one-sentence TL;DR — what this probe taught us",
  "payload": {
    "whatWeBelievedAtStart": "from the hypotheses' confidence_start values + plan hypothesis line",
    "whatChanged": "diff between confidence_start and confidence_current across hypotheses",
    "whatWorked": ["..."],
    "whatFailed": ["..."],
    "bestSegment": { "name": "...", "evidence": "concrete numbers" },
    "worstSegment": { "name": "...", "evidence": "concrete numbers" },
    "bestContactTitle": { "title": "...", "evidence": "..." } OR omit,
    "strongestSignal": { "signal": "...", "replyDelta": <number 0-1>, "evidence": "..." },
    "noisySignals": ["signal_x because reasons"],
    "badTargetRules": [{ "rule": "...", "rationale": "..." }],
    "recommendedNextProbe": {
      "country": "ISO-2",
      "segments": ["...", "..."],
      "hypothesesSeed": [{ "hypothesisType": "...", "statement": "..." }],
      "rationale": "why this next probe"
    },
    "playbookUpdates": {
      "name": "suggested playbook name (e.g. 'Caribbean Food Importer Playbook v1')",
      "applicableCountries": ["..."],
      "recommendedSegments": ["..."],
      "avoidedSegments": ["..."],
      "bestContactTitles": ["..."],
      "avoidedContactTitles": ["..."],
      "bestFirstTouchAngle": "...",
      "rationale": "..."
    }
  }
}

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function generateLearningReport(
  ctx: LearningReportContext,
): Promise<LearningReportResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No-key fallback: surface a deterministic skeleton rather than
    // failing the action. The operator sees the metric snapshot but
    // no LLM-synthesized text.
    return {
      summary: 'Learning report unavailable — Anthropic API not configured.',
      payload: {
        whatWeBelievedAtStart:
          'Plan hypothesis was: ' + ctx.productThesis.slice(0, 240),
        whatChanged: 'No synthesis available without API access.',
      },
    };
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Probe context:
- Name: ${ctx.probeName}
- Country: ${ctx.country ?? '(none)'}
- Product thesis: ${ctx.productThesis}
- Ladder stage at report time: ${ctx.ladderStage}
- Probe duration: ${ctx.durationDays} days

Scorecard:
${JSON.stringify(ctx.scorecard, null, 2)}

Hypotheses:
${JSON.stringify(ctx.hypotheses, null, 2)}

Segments:
${JSON.stringify(ctx.segments, null, 2)}

Top signals (reply-delta correlation):
${JSON.stringify(ctx.topSignals, null, 2)}

Atlas facts written during this probe:
${JSON.stringify(ctx.atlasFacts, null, 2)}

Feedback shortcuts the operator marked:
${JSON.stringify(ctx.feedbackShortcuts.slice(0, 50), null, 2)}

Strategy proposals the operator rejected (with feedback):
${JSON.stringify(ctx.rejectedStrategyProposals, null, 2)}
${
  ctx.priorLearningReports && ctx.priorLearningReports.length > 0
    ? `\nPrior learning reports in ${ctx.country ?? 'this country'} (most recent first) — SYNTHESIZE against these. Reference confirmations, contradictions, new ground; don't re-state what they already taught:\n${ctx.priorLearningReports
        .map(
          (r) =>
            `- [${r.generatedAt}] "${r.probeName}" — ${r.summary}\n  digest: ${r.payloadDigest}`,
        )
        .join('\n')}\n`
    : ''
}
Synthesize the JSON report.`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: { summary?: string; payload?: LearningReportPayload };
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      summary: 'Learning report parse failed — model emitted malformed JSON.',
      payload: {
        whatChanged: 'Re-run report generation; raw response logged.',
      },
    };
  }

  return {
    summary: parsed.summary ?? '(summary missing)',
    payload: parsed.payload ?? {},
  };
}
