import { getClient, MODELS } from '../client';

/**
 * Per-target justification drafter for Market Probes.
 *
 * The autopilot's send-batch gate filters on
 * `justificationState='justified'`, which only flips when all four
 * narrative fields on a target are populated:
 *   whyThisCompany, whyThisPerson, whyNow, safestFirstAsk
 *
 * Operators reported the manual-fill loop as the dominant launch
 * friction — a probe with 18 targets is 72 fields of free text before
 * autopilot can send anything. This agent collapses that to a one-
 * click "Draft" per target (and a "Draft all pending" bulk action),
 * pre-filling each field from the probe hypothesis + the entity's
 * dossier (web summaries, fuel-consumption signals, role/categories,
 * target-row evidence). The operator still saves to commit, so the
 * human-in-the-loop discipline the original UI was protecting stays
 * intact — we're removing the writing burden, not the review burden.
 *
 * Discipline:
 *   - This is propose-only. The action layer is responsible for
 *     deciding whether to overwrite an operator's existing field; the
 *     agent always returns all four.
 *   - The model NEVER invents facts beyond what the dossier supplies.
 *     If `whyThisPerson` has no resolved contact, the agent must
 *     write a role-based rationale and say so explicitly ("targeting
 *     procurement lead — once a named contact lands this becomes
 *     about that person").
 *   - `safestFirstAsk` is hard-constrained: a single deferential
 *     question, NEVER pricing/quantity/terms. Mirrors the discipline
 *     baked into the placeholder copy on the manual form.
 */

export interface JustificationContextDossier {
  /** Entity name as it appears on the rolodex (or external_suppliers
   *  organisation_name) — used as the primary subject of the draft. */
  entityName: string;
  entitySlug: string;
  /** ISO-2 country, when known. */
  country: string | null;
  /** Free-text role label from known_entities (e.g. "refiner",
   *  "power-station", "marine-bunker"). Null when the entity only
   *  exists in external_suppliers. */
  role: string | null;
  /** Category tags from known_entities (e.g. ["crude-oil", "diesel",
   *  "gasoline"]). Empty when no overlay exists. */
  categories: string[];
  /** Free-text tags from known_entities. */
  tags: string[];
  /** Target-row evidence items from the discovery ranker (role_match,
   *  category_match, customs_import, etc). Strings or short objects;
   *  the agent reads them verbatim. */
  evidenceItems: unknown[];
  /** entity_web_summaries content, keyed by section_kind
   *  (company_overview / products_services / operations /
   *  fuel_relevance / crude_relevance / logistics_relevance /
   *  contact_path). Truncated to ~400 chars per section by the caller. */
  webSummaries: Record<string, string>;
  /** Top fuel_consumption_signals — the agent uses these to ground
   *  whyThisCompany ("processes 30k bbl/yr per EITI 2023"). Up to 5;
   *  caller picks highest-confidence. */
  fuelSignals: Array<{
    source: string;
    signalKind: string | null;
    fuelType: string | null;
    volumeBblYrMin: number | null;
    volumeBblYrMax: number | null;
    confidence: number | null;
    coverageYear: number | null;
  }>;
  /** Whether a named contact is resolved on this target. When false,
   *  the agent writes role-based whyThisPerson and flags it. */
  hasResolvedContact: boolean;
}

export interface JustificationAgentContext {
  /** Probe hypothesis ("Are power plants in Peru looking for refined
   *  fuel partners?"). The frame the model reasons from. */
  probeHypothesis: string;
  /** Probe ladder stage. Drives the safest-first-ask register —
   *  market_structure / routing → routing-style; pain_discovery →
   *  qualifying; commercial_qualification → pricing-adjacent only. */
  ladderStage: string;
  /** Plan outreach angle from market_probes.plan_json.outreachAngle —
   *  the agent should align safestFirstAsk to this angle. */
  planOutreachAngle: string | null;
  /** Probe market name + product thesis — used for context. */
  marketName: string;
  productThesis: string;
  country: string | null;
  /** The target dossier — caller assembles this from getEntityProfile
   *  + getEntityWebIntelligenceWithOverlay + getFuelConsumptionSignals
   *  + the marketProbeTargets row. */
  dossier: JustificationContextDossier;
}

export interface DraftedJustification {
  whyThisCompany: string;
  whyThisPerson: string;
  whyNow: string;
  safestFirstAsk: string;
}

export type DraftJustificationResult =
  | { ok: true; draft: DraftedJustification }
  | { ok: false; reason: string };

const SYSTEM_PROMPT = `You are drafting per-target outreach justification for a bounded market-prospecting probe.

You will be given:
  - the probe hypothesis + market + product thesis
  - the probe's ladder stage (sequential: market_structure → routing → pain_discovery → commercial_qualification → deal_room_conversion)
  - a dossier on ONE target company (name, country, role, categories, web-intelligence summaries, fuel-consumption signals, target-row evidence)
  - whether a named contact is resolved on this target

Your job: return the four justification fields a human operator would write before approving outreach. The operator will review and edit before saving — your draft is a starting point, not the final copy.

Output ONE JSON object with exactly these keys (all strings, no nulls):
  - "whyThisCompany": one or two sentences citing the SPECIFIC dossier evidence that makes this company a real candidate. NEVER invent volumes, products, or relationships not present in the dossier. If the dossier is thin, say so plainly ("OSM tagging shows refiner role + diesel/gasoline categories — no consumption signal yet").
  - "whyThisPerson": one sentence. If hasResolvedContact=false, write a ROLE-BASED rationale and explicitly flag it: "Targeting <role/title> — replace once a named contact is resolved". If hasResolvedContact=true, write about that person's responsibility (the dossier will surface their context separately in a future iteration).
  - "whyNow": one sentence. The trigger — recent imports / new tender / hiring / news event / a fresh signal in the dossier. If no time-sensitive trigger exists, say "No specific trigger; routing pass to map the contact" — DON'T fabricate a trigger.
  - "safestFirstAsk": ONE deferential question. NEVER mention pricing, quantity, payment terms, contract length, volume commitments. The shape depends on ladder stage:
      market_structure / routing  →  "Are you the right person for ... inquiries?" or similar routing question
      pain_discovery              →  "How do you currently handle <product> sourcing?" or similar qualifying question
      commercial_qualification    →  Volume / cadence questions OK; still no firm pricing
      deal_room_conversion        →  Defer to operator — return "(operator-drafted)" since you should not draft commercial first-asks

Hard constraints:
  - Honesty over fluency. A thin dossier produces a thin justification — say so. Operators trust the system more when the agent admits uncertainty than when it confabulates.
  - Lead each field with the strongest signal from the dossier; don't bury it.
  - If the dossier contains fuel-consumption signals, cite the volume range + source year in whyThisCompany (e.g. "processes ~25–40k bbl/yr per EITI 2023").
  - Cap each field at 200 characters. Operators read these in a tight UI; longer copy gets ignored.

Return ONLY the JSON object — no preamble, no markdown fence.`;

export async function draftTargetJustification(
  ctx: JustificationAgentContext,
): Promise<DraftJustificationResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'ANTHROPIC_API_KEY is not set in this environment.',
    };
  }

  const client = getClient();
  const response = await client.messages.create({
    model: MODELS.sonnet,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Probe context:
- Market: ${ctx.marketName}${ctx.country ? ` (${ctx.country})` : ''}
- Product thesis: ${ctx.productThesis}
- Hypothesis: ${ctx.probeHypothesis}
- Ladder stage: ${ctx.ladderStage}
- Plan outreach angle: ${ctx.planOutreachAngle ?? '(not set; assume routing-style)'}

Target dossier:
${JSON.stringify(
  {
    entityName: ctx.dossier.entityName,
    entitySlug: ctx.dossier.entitySlug,
    country: ctx.dossier.country,
    role: ctx.dossier.role,
    categories: ctx.dossier.categories,
    tags: ctx.dossier.tags,
    hasResolvedContact: ctx.dossier.hasResolvedContact,
    evidenceItems: ctx.dossier.evidenceItems,
    webSummaries: ctx.dossier.webSummaries,
    fuelSignals: ctx.dossier.fuelSignals,
  },
  null,
  2,
)}

Emit the JSON object.`,
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

  if (response.stop_reason === 'max_tokens') {
    console.error(
      '[probe-justification-agent] response truncated at max_tokens',
      {
        target: ctx.dossier.entitySlug,
        outputTokens: response.usage?.output_tokens,
      },
    );
    return {
      ok: false,
      reason:
        'Sonnet response truncated. Try a target with a shorter dossier or rerun.',
    };
  }

  let parsed: Partial<DraftedJustification>;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[probe-justification-agent] JSON parse failed', {
      target: ctx.dossier.entitySlug,
      stopReason: response.stop_reason,
      err: err instanceof Error ? err.message : String(err),
      rawSnippet: text.slice(0, 300),
    });
    return {
      ok: false,
      reason: 'Sonnet returned malformed JSON; nothing drafted.',
    };
  }

  const required: Array<keyof DraftedJustification> = [
    'whyThisCompany',
    'whyThisPerson',
    'whyNow',
    'safestFirstAsk',
  ];
  const missing = required.filter(
    (k) => typeof parsed[k] !== 'string' || !parsed[k]!.trim(),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Sonnet response missing fields: ${missing.join(', ')}`,
    };
  }

  // Cap at 240 chars (above the prompt's 200 to give a small buffer
  // for the model overshoot — anything longer gets truncated rather
  // than rejected so the operator at least sees a draft to edit).
  const cap = (s: string) => (s.length > 240 ? `${s.slice(0, 237)}...` : s);

  return {
    ok: true,
    draft: {
      whyThisCompany: cap(parsed.whyThisCompany!.trim()),
      whyThisPerson: cap(parsed.whyThisPerson!.trim()),
      whyNow: cap(parsed.whyNow!.trim()),
      safestFirstAsk: cap(parsed.safestFirstAsk!.trim()),
    },
  };
}
