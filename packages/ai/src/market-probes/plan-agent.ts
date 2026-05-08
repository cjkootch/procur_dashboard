import { getClient, MODELS } from '../client';
import type { ProbePlan } from '@procur/db';

/**
 * Hypotheses the plan-gen agent emits alongside the plan. Caller
 * (the createProbe action) inserts these into market_probe_hypotheses.
 * Kept in this file (not exported) since the storage layer lives
 * in @procur/catalog and would create a circular dep.
 */
export interface ProposedHypothesis {
  hypothesisType: string;
  statement: string;
  confidenceStart: number;
  testMethod?: string;
}

export interface ProbePlanResult {
  plan: ProbePlan;
  hypotheses: ProposedHypothesis[];
}

/**
 * Plan generation for a Market Probe. Single Sonnet pass: given the
 * market name, country, product thesis, and operator's risk tolerance,
 * emit a structured plan with hypothesis, segments, outreach angle,
 * success criteria, and probe-specific tasks.
 *
 * Tasks ride into market_probes.plan_json so the dashboard can render
 * them as a crossing-off checklist as the agent advances. The prompt
 * gives the model the default task list and instructs it to ADAPT
 * (add/remove/relabel) — small markets may need fewer tasks; complex
 * thesis may need additional ones (e.g. "verify import licenses").
 *
 * Discipline: this is a propose-only call. The operator approves or
 * edits the plan before any target discovery / outreach starts.
 */
export interface ProbeContextForPlan {
  marketName: string;
  country: string | null;
  productThesis: string;
  riskLevel: 'low' | 'medium' | 'high';
  objective: string | null;
  allowedChannels: string[];
  dailySendLimit: number;
  totalSendLimit: number;
  /** Probe ladder stage. Constrains what kind of plan the agent
   *  emits — a probe at `market_structure` is doing rolodex-building,
   *  not commercial outreach. */
  ladderStage?:
    | 'market_structure'
    | 'routing'
    | 'pain_discovery'
    | 'commercial_qualification'
    | 'deal_room_conversion';
  /** Operator-rejected strategy proposals from prior runs of THIS
   *  probe. Riding into the next plan-generation pass as constraints
   *  is the loop that lets the system learn from rejection without
   *  retraining. Empty on first plan generation. */
  rejectionHistory?: Array<{
    proposalType: string;
    rationale: string;
    feedback: string | null;
    rejectedAt: string;
  }>;
  /** Negative rules (atlas fact_type='negative_rule') that apply to
   *  this market — prescriptive constraints from prior probes
   *  ("never target generic info@ addresses for fuel distributors").
   *  Empty when no prior probe has run in this country. */
  negativeRules?: string[];
}

const SYSTEM_PROMPT = `You are designing a bounded autonomous market-prospecting probe for a commodity trading desk.

Your job: given a market + product thesis, return a structured plan an operator will review and approve before any outreach starts. The probe is a CONTROLLED EXPERIMENT — you are testing whether the market has signal, not closing deals.

The probe sits at one of five sequential ladder stages. Tailor the plan to the current stage:
  market_structure         — building rolodex coverage. Plan focuses on identifying companies + segments. NO outreach yet.
  routing                  — first-touch routing emails ("are you the right person?"). NO commercial language.
  pain_discovery           — qualifying questions ("how do you currently handle X?"). Still no pricing.
  commercial_qualification — pricing intent / volume indications.
  deal_room_conversion     — formal LOI / NCNDA path. Hand off to the deal-room workflow.
You CANNOT propose outreach if the probe is at market_structure. You CANNOT propose pricing language unless the probe is at commercial_qualification or later.

Output a single JSON object with these fields:
- "hypothesis": one sentence — what kind of activity might exist in this market that the desk could plug into.
- "hypotheses": array of 3-7 falsifiable hypotheses we're testing. Each: {hypothesisType, statement, confidenceStart (0-1), testMethod}. Cover at least these kinds (drop one if the market doesn't warrant it):
    target_segment   — which buyer cluster we believe will respond
    contact_title    — which titles we believe respond more
    message_angle    — which email angle we believe works (routing vs supplier-intro vs ...)
    signal_quality   — which observable signals we believe predict interest (cold storage / serves hotels / Apollo presence / recent hiring)
    market_demand    — whether the market has enough volume to justify the probe in the first place
- "segments": array of 3-6 segment labels you propose targeting (e.g. "hotel/resort procurement", "marine bunker operators", "small fuel distributors").
- "outreachAngle": one sentence — what shape of email the agent will send. Should be ROUTING-style ("are you the right person?") UNLESS the probe is past pain_discovery.
- "successCriteria": 3-5 measurable outcomes the operator should expect at probe end (e.g. "5+ named procurement contacts identified", "3+ replies", "1+ qualified buying process").
- "tasks": array of {id, label} representing the operator-visible checklist. Reuse stable ids: generate_plan, identify_targets, find_contacts, draft_first_touch, send_first_touch, monitor_replies, summarize_findings. Mark "generate_plan" as the FIRST task with status "done" since the act of returning this JSON IS that task.

Constraints:
- The probe is bounded by daily/total send caps the operator has already set. Don't propose volumes the caps can't sustain.
- Don't propose commercial language at market_structure / routing / pain_discovery stages.
- Don't propose channels outside the allowed list.
- If negativeRules are provided (prescriptive rules from prior probes in this market), HONOR them — don't propose strategies the rules forbid.

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function generateProbePlan(
  ctx: ProbeContextForPlan,
): Promise<ProbePlanResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Without an API key, return a deterministic skeleton so the
    // operator can still see the probe shell and proceed manually.
    // The dashboard reads probe.plan_json — empty plan still renders.
    // Stamp generationStatus so the dashboard renders a fallback
    // banner and autopilot refuses to send (the alternative is a
    // probe that looks healthy but ships outreach grounded in
    // nothing).
    return {
      plan: {
        ...defaultPlan(ctx),
        generationStatus: 'fallback_no_api_key',
        generationError: 'ANTHROPIC_API_KEY is not set in this environment.',
      },
      hypotheses: [],
    };
  }

  const client = getClient();
  // 2500 matches the learning-report agent. The plan JSON has 5
  // arrays (hypotheses with statements + testMethods, segments,
  // successCriteria, tasks) plus prose fields — the original 1200
  // ceiling was tripping operators with malformed JSON whenever
  // Sonnet got slightly verbose, because the response would cut off
  // mid-string and JSON.parse blew up. The stop_reason check below
  // catches the residual truncation case and routes to a clearer
  // error than the generic parse-error fallback.
  const response = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Probe context:
- Market: ${ctx.marketName}${ctx.country ? ` (${ctx.country})` : ''}
- Product thesis: ${ctx.productThesis}
- Risk level: ${ctx.riskLevel}
- Objective: ${ctx.objective ?? '(unspecified)'}
- Ladder stage: ${ctx.ladderStage ?? 'market_structure'}
- Allowed channels: ${ctx.allowedChannels.join(', ')}
- Daily send cap: ${ctx.dailySendLimit}
- Total send cap: ${ctx.totalSendLimit}
${
  ctx.negativeRules && ctx.negativeRules.length > 0
    ? `\nNegative rules from prior probes in this market (HONOR — don't violate):\n${ctx.negativeRules.map((r) => `- ${r}`).join('\n')}\n`
    : ''
}${
  ctx.rejectionHistory && ctx.rejectionHistory.length > 0
    ? `\nOperator-rejected proposals from prior plan revisions on this probe (DO NOT re-propose these directions; the operator's feedback explains why):\n${ctx.rejectionHistory
        .map(
          (r) =>
            `- ${r.proposalType} [${r.rejectedAt}]: ${r.rationale}\n  operator feedback: ${r.feedback ?? '(no feedback given)'}`,
        )
        .join('\n')}\n`
    : ''
}
Produce the plan JSON.`,
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

  // Hitting max_tokens means the JSON was cut mid-string — JSON.parse
  // would fail with a generic "unexpected end" that the operator
  // can't act on. Surface the real cause so they know to bump the
  // cap rather than chase phantom Sonnet shape regressions.
  if (response.stop_reason === 'max_tokens') {
    console.error('[probe-plan-agent] response truncated at max_tokens', {
      market: ctx.marketName,
      country: ctx.country,
      maxTokens: 2500,
      outputTokens: response.usage?.output_tokens,
      rawSnippet: text.slice(0, 300),
    });
    return {
      plan: {
        ...defaultPlan(ctx),
        generationStatus: 'fallback_parse_error',
        generationError: `Sonnet response truncated at max_tokens=2500. Used ${response.usage?.output_tokens ?? '?'} output tokens before being cut. Bump the cap or shorten the prompt.`,
      },
      hypotheses: [],
    };
  }

  let parsed: ProbePlan & { hypotheses?: ProposedHypothesis[] };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Don't blow up the probe on a malformed response — fall back to
    // the default skeleton. Operator can edit + re-run. Log loudly
    // so the operator can see WHY the probe came up with an empty
    // plan (silent fallback was masking Sonnet shape regressions —
    // operator saw an "active" probe with zero hypotheses and no
    // explanation).
    console.error('[probe-plan-agent] JSON parse failed; using skeleton', {
      market: ctx.marketName,
      country: ctx.country,
      stopReason: response.stop_reason,
      err: err instanceof Error ? err.message : String(err),
      rawSnippet: text.slice(0, 300),
    });
    return {
      plan: {
        ...defaultPlan(ctx),
        generationStatus: 'fallback_parse_error',
        generationError: `Sonnet returned malformed JSON (stop_reason=${response.stop_reason}). Raw prefix: ${text.slice(0, 200)}`,
      },
      hypotheses: [],
    };
  }

  // Defensive coalesce — if any field missing, fill with default. The
  // model occasionally drops fields when it gets terse.
  const fallback = defaultPlan(ctx);
  const plan: ProbePlan = {
    generationStatus: 'ok',
    hypothesis: parsed.hypothesis ?? fallback.hypothesis,
    segments:
      Array.isArray(parsed.segments) && parsed.segments.length > 0
        ? parsed.segments
        : fallback.segments,
    outreachAngle: parsed.outreachAngle ?? fallback.outreachAngle,
    successCriteria:
      Array.isArray(parsed.successCriteria) && parsed.successCriteria.length > 0
        ? parsed.successCriteria
        : fallback.successCriteria,
    tasks: normalizeTasks(parsed.tasks ?? fallback.tasks ?? []),
  };
  const hypotheses = Array.isArray(parsed.hypotheses)
    ? parsed.hypotheses.filter(
        (h): h is ProposedHypothesis =>
          typeof h?.hypothesisType === 'string' &&
          typeof h?.statement === 'string' &&
          h.statement.length > 0,
      )
    : [];
  return { plan, hypotheses };
}

function defaultPlan(ctx: ProbeContextForPlan): ProbePlan {
  return {
    hypothesis: `Companies in ${ctx.marketName} that periodically source ${ctx.productThesis} from outside the local market.`,
    segments: ['distributors', 'industrial buyers', 'service operators'],
    outreachAngle:
      'Short routing email asking who handles commercial supply or procurement inquiries.',
    successCriteria: [
      '5+ named procurement contacts identified',
      '3+ replies',
      '1+ qualified buying process',
    ],
    tasks: [
      {
        id: 'generate_plan',
        label: 'Generate market plan',
        status: 'done',
        completedAt: new Date().toISOString(),
        result: 'Default plan (no LLM available)',
      },
      { id: 'identify_targets', label: 'Identify target companies', status: 'pending' },
      { id: 'find_contacts', label: 'Find named contacts', status: 'pending' },
      {
        id: 'draft_first_touch',
        label: 'Draft first-touch routing emails',
        status: 'pending',
      },
      { id: 'send_first_touch', label: 'Send approved drafts', status: 'pending' },
      { id: 'monitor_replies', label: 'Monitor replies + classify', status: 'pending' },
      {
        id: 'summarize_findings',
        label: 'Summarize findings + recommend next step',
        status: 'pending',
      },
    ],
  };
}

function normalizeTasks(
  raw: NonNullable<ProbePlan['tasks']>,
): NonNullable<ProbePlan['tasks']> {
  return raw
    .filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string')
    .map((t) => ({
      id: t.id,
      label: t.label,
      status: ['pending', 'in_progress', 'done', 'skipped'].includes(t.status as string)
        ? (t.status as 'pending' | 'in_progress' | 'done' | 'skipped')
        : 'pending',
      ...(t.completedAt ? { completedAt: t.completedAt } : {}),
      ...(t.result ? { result: t.result } : {}),
    }));
}
