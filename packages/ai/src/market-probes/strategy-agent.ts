import { getClient, MODELS } from '../client';

/**
 * Strategy adaptation agent for Market Probes.
 *
 * Given a probe's current plan, recent send/reply metrics, and the
 * history of operator-rejected proposals, the agent emits a list of
 * candidate plan changes for operator review. Each change carries a
 * rationale grounded in the metric snapshot.
 *
 * Discipline:
 *   - The agent NEVER mutates the plan directly. It only EMITS
 *     proposals into market_probe_strategy_proposals; the operator
 *     approves or rejects.
 *   - Rejection context (operator-rejected proposals + their feedback)
 *     rides into the next prompt as constraints. This is the loop
 *     that lets the system learn without retraining.
 *
 * Returns 0-3 proposals. Empty array is a valid result — when the
 * probe is on track, no adjustment is needed.
 */

export interface ProbeMetricsSnapshot {
  /** ISO timestamp the snapshot was taken. */
  asOf: string;
  targetCount: number;
  sentCount: number;
  repliedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  positiveReplies: number;
  /** Per-segment breakdown — { hotel: { sent: 8, replied: 1 }, ... } */
  segmentBreakdown: Record<
    string,
    { sent: number; replied: number; positiveReplies: number }
  >;
  /** Per-fit-tier breakdown. */
  tierBreakdown: Record<
    string,
    { sent: number; replied: number; positiveReplies: number }
  >;
}

export interface ProbeContextForStrategy {
  marketName: string;
  country: string | null;
  productThesis: string;
  status: string;
  currentPlan: {
    hypothesis?: string;
    segments?: string[];
    outreachAngle?: string;
    successCriteria?: string[];
  };
  metrics: ProbeMetricsSnapshot;
  rejectionHistory: Array<{
    proposalType: string;
    rationale: string;
    feedback: string | null;
    rejectedAt: string;
  }>;
}

export interface ProbeStrategyProposal {
  proposalType:
    | 'shift_segment'
    | 'add_segment'
    | 'pause_segment'
    | 'change_template'
    | 'tighten_targeting'
    | 'loosen_targeting'
    | 'shift_titles'
    | 'pause_probe'
    | 'complete_probe';
  rationale: string;
  payload: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    summary?: string;
  };
}

const SYSTEM_PROMPT = `You are the strategy adaptation agent for a Market Probe — a bounded autonomous market-prospecting experiment.

Your job: review the probe's current plan + recent metrics + history of operator-rejected proposals. Emit 0-3 plan-change proposals for operator review. The operator approves or rejects each; approved proposals modify the probe's plan, rejected proposals carry their feedback into your next pass as constraints.

Discipline:
- Each proposal must be grounded in a specific metric. "0 replies from fuel distributors after 8 sends" is concrete; "we should try a new angle" is not.
- DO NOT re-propose the same change the operator already rejected unless the feedback specifically suggests adapting it.
- DO NOT propose changes that would expand the probe scope (e.g. raising send caps, adding new countries, switching channels) — those require operator-initiated edits, not agent proposals.
- Return EMPTY proposals[] array when the probe is on track. Not every check-in needs a change.

Proposal types:
- shift_segment: stop targeting one segment, prioritize another
- add_segment: include a new segment in addition to existing ones
- pause_segment: stop targeting one segment without replacement
- change_template: swap the first-touch outreach angle (e.g. routing → introduction)
- tighten_targeting: send only to higher fit tiers (skip C/D)
- loosen_targeting: include B-tier candidates the operator was filtering out
- shift_titles: prioritize different decision-maker titles based on reply data
- pause_probe: recommend operator pause the entire probe (signal too weak to continue)
- complete_probe: recommend operator mark complete (objective met)

Output a single JSON object:
{
  "proposals": [
    {
      "proposalType": "...",
      "rationale": "Specific, metric-grounded — e.g. 'Hotel procurement segment: 8 sent, 0 replies. Marine ops segment: 4 sent, 2 routing replies. Recommend pivoting send budget to marine ops.'",
      "payload": {
        "before": { ... fields being changed ... },
        "after": { ... new values ... },
        "summary": "one-sentence summary the operator will see in the diff"
      }
    }
  ]
}

For shift_segment / add_segment / pause_segment / shift_titles, the after.segments array MUST contain the FULL new list (not just the delta).
For change_template, after.outreachAngle is a one-sentence description.
For pause_probe / complete_probe, payload may be empty {} — the rationale carries the case.

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function proposeProbeStrategyAdjustments(
  ctx: ProbeContextForStrategy,
): Promise<ProbeStrategyProposal[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No-key fallback: emit no proposals. The strategy agent is
    // fundamentally LLM-driven (it produces rationale text); no
    // useful deterministic skeleton exists.
    return [];
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Probe context:
Market: ${ctx.marketName}${ctx.country ? ` (${ctx.country})` : ''}
Status: ${ctx.status}
Product thesis: ${ctx.productThesis}

Current plan:
- Hypothesis: ${ctx.currentPlan.hypothesis ?? '(none)'}
- Segments: ${JSON.stringify(ctx.currentPlan.segments ?? [])}
- Outreach angle: ${ctx.currentPlan.outreachAngle ?? '(none)'}
- Success criteria: ${JSON.stringify(ctx.currentPlan.successCriteria ?? [])}

Metrics snapshot (as of ${ctx.metrics.asOf}):
- Targets: ${ctx.metrics.targetCount}
- Sent: ${ctx.metrics.sentCount}
- Replied: ${ctx.metrics.repliedCount}
- Bounced: ${ctx.metrics.bouncedCount}
- Unsubscribed: ${ctx.metrics.unsubscribedCount}
- Positive/routing replies: ${ctx.metrics.positiveReplies}

Per-segment breakdown:
${JSON.stringify(ctx.metrics.segmentBreakdown, null, 2)}

Per-fit-tier breakdown:
${JSON.stringify(ctx.metrics.tierBreakdown, null, 2)}

Operator-rejected proposals (most recent first) — DO NOT re-propose unless feedback explicitly points at how to adapt:
${
  ctx.rejectionHistory.length === 0
    ? '(none)'
    : ctx.rejectionHistory
        .map(
          (r) =>
            `- [${r.rejectedAt}] ${r.proposalType}: ${r.rationale}\n  feedback: ${r.feedback ?? '(no feedback given)'}`,
        )
        .join('\n')
}

Emit your proposals JSON.`,
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

  let parsed: { proposals?: ProbeStrategyProposal[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    // Malformed response — treat as no proposals rather than failing
    // the operator's review session.
    return [];
  }

  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  // Defensive validation — drop proposals missing required fields.
  return proposals.filter(
    (p): p is ProbeStrategyProposal =>
      typeof p?.proposalType === 'string' &&
      typeof p?.rationale === 'string' &&
      p.rationale.length > 0,
  );
}
