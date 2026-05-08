import { getClient, MODELS } from '../client';

/**
 * Variant authoring agent for Market Probes.
 *
 * Today operators hand-author variants via the dashboard. When a
 * probe runs for weeks and variant A replies at 18% while B replies
 * at 12%, no mechanism nominates a third variant that blends A's
 * winning angle with B's tone — operators have to spot the
 * opportunity and write it themselves. This agent fills that gap:
 * given current variants + per-variant performance + plan context,
 * it emits 0-3 nominations the operator approves before the
 * variant lands as a real `paused` row.
 *
 * Discipline (mirrors strategy-agent):
 *   - The agent NEVER promotes / archives existing variants
 *     directly. It only NOMINATES new variants for operator review.
 *     Status changes still flow through the existing
 *     setVariantStatus action.
 *   - Nominations carry a rationale grounded in observed performance
 *     (specific reply-rate deltas, not vague "let's try a new tone").
 *   - DO NOT propose more than 3 nominations per pass — variant
 *     proliferation kills statistical signal.
 *   - DO NOT propose nominations when sample sizes are too thin
 *     (any variant with < 5 sends is unobserved; agent can't ground
 *     a nomination on it).
 *   - Empty array is a valid result — when the probe is on track or
 *     when sample sizes are too thin, no nomination is correct.
 */

export interface VariantPerformanceForAgent {
  variantId: string;
  variantName: string;
  status: 'active' | 'paused' | 'winner' | 'archived';
  angle: string | null;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  sent: number;
  replied: number;
  positiveReplied: number;
  bounced: number;
  unsubscribed: number;
  replyRate: number;
  positiveReplyRate: number;
  bounceRate: number;
}

export interface VariantAgentContext {
  probeName: string;
  country: string | null;
  productThesis: string;
  ladderStage: string;
  /** Plan outreach angle — the agent's nominations should be variants
   *  AGAINST this angle, not orthogonal pivots. Variants are A/B
   *  tests of the SAME plan; pivot proposals belong to the
   *  strategy-agent. */
  planOutreachAngle: string;
  /** Operator-rejected nominations from prior runs of this probe.
   *  The agent should NOT re-propose the same nomination unless the
   *  feedback specifically points at how to adapt. Empty on first
   *  pass. */
  rejectedNominations?: Array<{
    variantName: string;
    rationale: string;
    feedback: string | null;
    rejectedAt: string;
  }>;
  /** Current variants (active + paused + winner + archived) with
   *  per-variant performance. Archived variants are included so the
   *  agent can avoid resurrecting one the operator already retired. */
  currentVariants: VariantPerformanceForAgent[];
}

export interface VariantNomination {
  variantName: string;
  /** One-line angle description. The operator's variant editor pulls
   *  this into the angle field. */
  angle: string;
  /** Optional subject-line template. Single string or null. */
  subjectTemplate: string | null;
  /** Optional body-template direction. Brief — the autopilot's
   *  drafter reads this as guidance, not literal copy. */
  bodyTemplate: string | null;
  /** Initial weight (operator can override). Default 1. */
  weight: number;
  /** Operator-facing rationale. Specific, performance-grounded:
   *  "Variant A's 'are you the right person' angle replies 18% but
   *   formal tone; variant B's casual tone replies 12% on a different
   *   ask. Hybrid: A's question with B's casual tone — test if
   *   tone-only delta closes the gap." */
  rationale: string;
}

const SYSTEM_PROMPT = `You are the variant authoring agent for a Market Probe — a bounded autonomous market-prospecting experiment that A/B tests outreach variants.

Your job: review the probe's current variants + per-variant reply performance + plan context. Emit 0-3 NEW variant nominations for operator review. Each nomination becomes a 'paused' variant row when approved; the operator activates it manually via the existing variant UI.

Discipline:
- Nominations must be grounded in observed performance. "Variant A replied 18% but had a formal tone; variant B replied 12% but had a question hook. Hybrid: A's tone with B's question hook" is concrete; "let's try a new variant" is not.
- DO NOT propose more than 3 nominations. Variant proliferation kills statistical signal.
- DO NOT propose a nomination when no variant has ≥ 5 sends — sample sizes are too thin to ground a hypothesis.
- DO NOT propose a nomination that duplicates an archived variant — the operator already retired it.
- DO NOT propose nominations that change the PLAN's outreach angle (that's the strategy-agent's job). Variants are tests AGAINST the plan, not pivots away from it.
- DO NOT re-propose a nomination the operator rejected unless the feedback specifically points at how to adapt.
- Return EMPTY nominations[] array when the probe is on track or sample sizes are too thin.

Output a single JSON object:
{
  "nominations": [
    {
      "variantName": "short label, max 40 chars (e.g. 'Hybrid: A's tone with B's question')",
      "angle": "one-sentence angle description",
      "subjectTemplate": "subject template OR null",
      "bodyTemplate": "body-template direction OR null",
      "weight": 1,
      "rationale": "Specific, performance-grounded — cite specific reply rates and what hypothesis the variant tests."
    }
  ]
}

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function proposeVariantAdjustments(
  ctx: VariantAgentContext,
): Promise<VariantNomination[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // No-key fallback: emit no nominations. The agent is fundamentally
    // LLM-driven (rationale text + angle synthesis); no useful
    // deterministic output.
    return [];
  }

  // Sample-size floor — refuse to ask the LLM when no variant has
  // observed enough sends to ground a hypothesis. Saves a token spend
  // and prevents the agent from "inventing" justifications. 5 sends
  // is the minimum the strategy-agent treats as observed; matching
  // that threshold here.
  const observed = ctx.currentVariants.filter((v) => v.sent >= 5);
  if (observed.length === 0) {
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
Name: ${ctx.probeName}
Country: ${ctx.country ?? '(none)'}
Product thesis: ${ctx.productThesis}
Ladder stage: ${ctx.ladderStage}
Plan outreach angle: ${ctx.planOutreachAngle}

Current variants (with per-variant performance):
${JSON.stringify(
  ctx.currentVariants.map((v) => ({
    name: v.variantName,
    status: v.status,
    angle: v.angle,
    subject: v.subjectTemplate,
    body: v.bodyTemplate,
    sent: v.sent,
    replied: v.replied,
    positiveReplied: v.positiveReplied,
    replyRate: Number(v.replyRate.toFixed(3)),
    positiveReplyRate: Number(v.positiveReplyRate.toFixed(3)),
    bounceRate: Number(v.bounceRate.toFixed(3)),
  })),
  null,
  2,
)}

${
  ctx.rejectedNominations && ctx.rejectedNominations.length > 0
    ? `Operator-rejected nominations (most recent first) — DO NOT re-propose unless feedback explicitly points at how to adapt:\n${ctx.rejectedNominations
        .map(
          (r) =>
            `- [${r.rejectedAt}] "${r.variantName}": ${r.rationale}\n  feedback: ${r.feedback ?? '(no feedback given)'}`,
        )
        .join('\n')}`
    : ''
}

Emit your nominations JSON.`,
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

  let parsed: { nominations?: VariantNomination[] };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Malformed response — log and return empty rather than fail the
    // operator's review session.
    console.error(
      '[variant-agent] JSON parse failed; returning no nominations',
      {
        probe: ctx.probeName,
        err: err instanceof Error ? err.message : String(err),
        rawSnippet: text.slice(0, 300),
      },
    );
    return [];
  }

  const noms = Array.isArray(parsed.nominations) ? parsed.nominations : [];
  // Defensive validation. Drop rows missing required fields, cap to 3,
  // sanitize weight to a positive number.
  return noms
    .filter(
      (n): n is VariantNomination =>
        typeof n?.variantName === 'string' &&
        n.variantName.length > 0 &&
        typeof n?.angle === 'string' &&
        n.angle.length > 0 &&
        typeof n?.rationale === 'string' &&
        n.rationale.length > 0,
    )
    .slice(0, 3)
    .map((n) => ({
      variantName: n.variantName.slice(0, 100),
      angle: n.angle,
      subjectTemplate: n.subjectTemplate ?? null,
      bodyTemplate: n.bodyTemplate ?? null,
      weight: Number.isFinite(Number(n.weight))
        ? Math.max(0, Math.min(10, Number(n.weight)))
        : 1,
      rationale: n.rationale,
    }));
}
