import { getClient, MODELS } from '../client';
import type { ProbePlan } from '@procur/db';

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
}

const SYSTEM_PROMPT = `You are designing a bounded autonomous market-prospecting probe for a commodity trading desk.

Your job: given a market + product thesis, return a structured plan an operator will review and approve before any outreach starts. The probe is a CONTROLLED EXPERIMENT — you are testing whether the market has signal, not closing deals.

Output a single JSON object with these fields:
- "hypothesis": one sentence — what kind of activity might exist in this market that the desk could plug into.
- "segments": array of 3-6 segment labels you propose targeting (e.g. "hotel/resort procurement", "marine bunker operators", "small fuel distributors").
- "outreachAngle": one sentence — what shape of email the agent will send. Should be ROUTING-style ("are you the right person?"), NEVER pricing or commercial commitment.
- "successCriteria": 3-5 measurable outcomes the operator should expect at probe end (e.g. "5+ named procurement contacts identified", "3+ replies", "1+ qualified buying process").
- "tasks": array of {id, label} representing the operator-visible checklist. Reuse these stable ids when applicable: generate_plan, identify_targets, find_contacts, draft_first_touch, send_first_touch, monitor_replies, summarize_findings. Add probe-specific tasks (e.g. "verify import licensing") if the thesis warrants it. Mark "generate_plan" as the FIRST task with status "done" since the act of returning this JSON IS that task.

Constraints:
- The probe is bounded by daily/total send caps the operator has already set. Don't propose volumes the caps can't sustain.
- Don't propose commercial language. The agent's first-touch must be discovery-only ("who handles supplier inquiries?").
- Don't propose channels outside the allowed list.

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function generateProbePlan(
  ctx: ProbeContextForPlan,
): Promise<ProbePlan> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Without an API key, return a deterministic skeleton so the
    // operator can still see the probe shell and proceed manually.
    // The dashboard reads probe.plan_json — empty plan still renders.
    return defaultPlan(ctx);
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Probe context:
- Market: ${ctx.marketName}${ctx.country ? ` (${ctx.country})` : ''}
- Product thesis: ${ctx.productThesis}
- Risk level: ${ctx.riskLevel}
- Objective: ${ctx.objective ?? '(unspecified)'}
- Allowed channels: ${ctx.allowedChannels.join(', ')}
- Daily send cap: ${ctx.dailySendLimit}
- Total send cap: ${ctx.totalSendLimit}
${
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

  let parsed: ProbePlan;
  try {
    parsed = JSON.parse(text) as ProbePlan;
  } catch {
    // Don't blow up the probe on a malformed response — fall back to
    // the default skeleton. Operator can edit + re-run.
    return defaultPlan(ctx);
  }

  // Defensive coalesce — if any field missing, fill with default. The
  // model occasionally drops fields when it gets terse.
  const fallback = defaultPlan(ctx);
  return {
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
