import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  db,
  fuelDealCostStack,
  fuelDealScenarios,
  fuelDeals,
  organizations,
  revenueAssumptions,
  type AssumptionStatusValue,
  type AssumptionSubjectTypeValue,
  type AssumptionTypeValue,
  ASSUMPTION_TYPES,
} from '@procur/db';
import { createId, getClient, MODELS } from '@procur/ai';

/**
 * Revenue Assumption Map ("Counterfactual Deal Simulator") catalog
 * helpers — per Cole's brief at docs/revenue-assumption-map.md.
 *
 * Concept: every deal/opportunity/lead/org gets a small decision
 * tree of assumptions that must be true for it to become real
 * revenue. Each assumption carries a confidence + the cheapest test
 * + the action type that test maps to.
 *
 * v1: only `subject_type='fuel_deal'` is wired into the UI; the
 * column shape supports the others without further migration.
 *
 * Pipeline:
 *   1. `generateAssumptionMap` calls Sonnet with deal context →
 *      returns 6-10 typed assumptions (NOT yet saved).
 *   2. Operator reviews via /deals/[id]?tab=assumptions; chat tool
 *      `propose_save_assumption_map` proposes a bulk save.
 *   3. As the operator runs tests (sends emails, gets replies, runs
 *      sanctions screens), `propose_record_assumption_test` updates
 *      individual rows with status + result + result_evidence.
 *
 * SAFETY DISCIPLINE
 *   - Confidence scores are operator-facing, never injected into
 *     outbound copy.
 *   - Generator output is structured JSON — refused if the model
 *     returns prose or invalid types.
 *   - Save + test-record run through the approval queue so nothing
 *     mutates the row without an explicit approve.
 */

const GENERATOR_VERSION = 'gen-v1';

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export type AssumptionRow = typeof revenueAssumptions.$inferSelect;

export interface GeneratedAssumption {
  assumptionType: AssumptionTypeValue;
  assumptionText: string;
  confidenceScore: number;
  fastestTest: string;
  riskIfFalse: string;
  recommendedActionType: string | null;
}

export interface GenerateAssumptionMapInput {
  subjectType: AssumptionSubjectTypeValue;
  subjectId: string;
}

export interface GenerateAssumptionMapResult {
  generatorVersion: string;
  assumptions: GeneratedAssumption[];
  /** True when the LLM was unavailable and we fell back to a fixed
   *  template. The template is operator-useful but flagged so the UI
   *  can prompt for re-generation when the API key is set. */
  fromTemplate: boolean;
  /** Brief of the context the generator saw — surfaces in the
   *  audit panel so the operator knows what the model knew. */
  contextSummary: string;
}

export interface AssumptionTestInput {
  assumptionId: string;
  status: AssumptionStatusValue;
  /** Operator's free-form result, e.g. "Procurement Director confirmed authority via email reply" */
  result: string;
  /** Pointers back to records that produced the result —
   *  approval id, touchpoint id, screen id, etc. */
  resultEvidence?: Record<string, unknown>;
  /** New confidence score after running the test (0-100). */
  confidenceScore?: number;
}

// ----------------------------------------------------------------------------
// Read helpers
// ----------------------------------------------------------------------------

/**
 * Fetch the full assumption map for a subject. Ordered by status
 * (untested first → operator's eye lands on what still needs work)
 * then by assumption type for stable rendering.
 */
export async function getAssumptionMap(
  subjectType: AssumptionSubjectTypeValue,
  subjectId: string,
): Promise<AssumptionRow[]> {
  return db
    .select()
    .from(revenueAssumptions)
    .where(
      and(
        eq(revenueAssumptions.subjectType, subjectType),
        eq(revenueAssumptions.subjectId, subjectId),
      ),
    )
    .orderBy(
      asc(revenueAssumptions.status),
      asc(revenueAssumptions.assumptionType),
    );
}

// ----------------------------------------------------------------------------
// Write helpers
// ----------------------------------------------------------------------------

/**
 * Insert or update a single assumption row. Used by the chat-tool
 * paths (propose_save_assumption_map / propose_record_assumption_test)
 * after the operator approves.
 *
 * Uniqueness key: (subject_type, subject_id, assumption_type) —
 * one assumption-of-each-type per subject. Re-saving with the same
 * type updates in place rather than duplicating.
 */
export async function upsertAssumption(input: {
  subjectType: AssumptionSubjectTypeValue;
  subjectId: string;
  assumptionType: AssumptionTypeValue;
  assumptionText: string;
  confidenceScore: number;
  riskIfFalse?: string;
  fastestTest?: string;
  recommendedActionType?: string | null;
  generatorVersion?: string;
  createdBy?: string;
}): Promise<{ id: string; created: boolean }> {
  const existing = await db
    .select({ id: revenueAssumptions.id })
    .from(revenueAssumptions)
    .where(
      and(
        eq(revenueAssumptions.subjectType, input.subjectType),
        eq(revenueAssumptions.subjectId, input.subjectId),
        eq(revenueAssumptions.assumptionType, input.assumptionType),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(revenueAssumptions)
      .set({
        assumptionText: input.assumptionText,
        confidenceScore: input.confidenceScore,
        ...(input.riskIfFalse !== undefined ? { riskIfFalse: input.riskIfFalse } : {}),
        ...(input.fastestTest !== undefined ? { fastestTest: input.fastestTest } : {}),
        ...(input.recommendedActionType !== undefined
          ? { recommendedActionType: input.recommendedActionType }
          : {}),
        ...(input.generatorVersion ? { generatorVersion: input.generatorVersion } : {}),
        updatedAt: new Date(),
      })
      .where(eq(revenueAssumptions.id, existing[0].id));
    return { id: existing[0].id, created: false };
  }

  const id = createId();
  await db.insert(revenueAssumptions).values({
    id,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    assumptionType: input.assumptionType,
    assumptionText: input.assumptionText,
    confidenceScore: input.confidenceScore,
    ...(input.riskIfFalse ? { riskIfFalse: input.riskIfFalse } : {}),
    ...(input.fastestTest ? { fastestTest: input.fastestTest } : {}),
    ...(input.recommendedActionType
      ? { recommendedActionType: input.recommendedActionType }
      : {}),
    ...(input.generatorVersion ? { generatorVersion: input.generatorVersion } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });
  return { id, created: true };
}

/**
 * Record a test result against an assumption. Updates status +
 * result + result_evidence + tested_at + (optionally) confidence.
 * Idempotent on `(assumptionId, latest test)` — re-running with the
 * same inputs is fine.
 */
export async function recordAssumptionTest(
  input: AssumptionTestInput,
): Promise<void> {
  await db
    .update(revenueAssumptions)
    .set({
      status: input.status,
      result: input.result,
      ...(input.resultEvidence
        ? { resultEvidence: input.resultEvidence }
        : {}),
      ...(input.confidenceScore !== undefined
        ? { confidenceScore: input.confidenceScore }
        : {}),
      testedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(revenueAssumptions.id, input.assumptionId));
}

// ----------------------------------------------------------------------------
// LLM generator
// ----------------------------------------------------------------------------

/**
 * Generate an initial assumption map for a subject. Reads enough
 * context to ground the generator (deal + buyer + cost stack +
 * compliance state for fuel_deals; counterpart info for orgs/leads/
 * opportunities once those land), then asks Sonnet to produce 6-10
 * typed assumptions across the 10-value taxonomy.
 *
 * Returns the generated set WITHOUT inserting — the caller (chat
 * tool) decides whether to save them via the propose-save path.
 *
 * Falls back to a fixed template when ANTHROPIC_API_KEY is missing
 * (test environments + first-run setups). The template is operator-
 * useful but `fromTemplate: true` is set so the UI can prompt a
 * re-generation when the key is present.
 */
export async function generateAssumptionMap(
  input: GenerateAssumptionMapInput,
): Promise<GenerateAssumptionMapResult> {
  if (input.subjectType !== 'fuel_deal') {
    // v1: only fuel_deal context-loading is implemented. Other types
    // get a generic template until their loaders ship.
    return templateMap('subjectType not yet supported by v1 generator');
  }

  const context = await loadFuelDealContext(input.subjectId);
  if (!context) {
    return templateMap(`fuel_deal ${input.subjectId} not found`);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return templateMap(
      `${context.dealRef} (${context.product}, buyer ${context.buyerLegalName ?? '?'})`,
    );
  }

  const prompt = buildPrompt(context);
  let raw: string;
  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.sonnet,
      max_tokens: 2500,
      system: GENERATOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    raw = block && 'text' in block ? block.text : '';
  } catch {
    return templateMap(
      `${context.dealRef} (LLM unavailable; using template)`,
    );
  }

  const parsed = safeJsonParse(raw);
  const assumptions = validateAssumptions(parsed);
  if (!assumptions || assumptions.length === 0) {
    return templateMap(
      `${context.dealRef} (LLM output unparseable; using template)`,
    );
  }

  return {
    generatorVersion: GENERATOR_VERSION,
    assumptions,
    fromTemplate: false,
    contextSummary: `${context.dealRef} · ${context.product} · ${context.buyerLegalName ?? context.buyerOrgId ?? '?'} · ${context.incoterm} · ${context.disclosureAllowed ? 'disclosure_allowed=true' : 'disclosure_blocked'}`,
  };
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

interface FuelDealContext {
  dealRef: string;
  product: string;
  incoterm: string;
  paymentTerms: string;
  volumeUsg: number;
  destinationPort: string | null;
  buyerOrgId: string | null;
  buyerLegalName: string | null;
  ndaSignedAt: Date | null;
  feeProtectionStatus: string | null;
  disclosureAllowed: boolean;
  ofacScreeningStatus: string;
  complianceHold: boolean;
  productCostPerUsg: number | null;
  totalLandedCostPerUsg: number | null;
  sellPricePerUsg: number | null;
  scenarioRecommendation: string | null;
}

async function loadFuelDealContext(
  dealId: string,
): Promise<FuelDealContext | null> {
  const dealRows = await db
    .select()
    .from(fuelDeals)
    .where(eq(fuelDeals.id, dealId))
    .limit(1);
  const deal = dealRows[0];
  if (!deal) return null;

  const [buyerRows, scenarioRows, stackRows] = await Promise.all([
    deal.buyerOrgId
      ? db
          .select({
            id: organizations.id,
            legalName: organizations.legalName,
          })
          .from(organizations)
          .where(eq(organizations.id, deal.buyerOrgId))
          .limit(1)
      : Promise.resolve([] as Array<{ id: string; legalName: string }>),
    db
      .select()
      .from(fuelDealScenarios)
      .where(
        and(
          eq(fuelDealScenarios.dealId, dealId),
          eq(fuelDealScenarios.isActive, true),
        ),
      )
      .orderBy(desc(fuelDealScenarios.updatedAt))
      .limit(1),
    db
      .select()
      .from(fuelDealCostStack)
      .where(eq(fuelDealCostStack.dealId, dealId))
      .limit(1),
  ]);

  const scenario = scenarioRows[0] ?? null;
  const results = (scenario?.resultsJson ?? {}) as {
    scorecard?: { recommendation?: string };
  };

  return {
    dealRef: deal.dealRef,
    product: deal.product,
    incoterm: deal.incoterm,
    paymentTerms: deal.paymentTerms,
    volumeUsg: deal.volumeUsg,
    destinationPort: deal.destinationPort ?? null,
    buyerOrgId: deal.buyerOrgId,
    buyerLegalName: buyerRows[0]?.legalName ?? null,
    ndaSignedAt: deal.ndaSignedAt ?? null,
    feeProtectionStatus: deal.feeProtectionStatus ?? null,
    disclosureAllowed: deal.disclosureAllowed,
    ofacScreeningStatus: deal.ofacScreeningStatus,
    complianceHold: deal.complianceHold,
    productCostPerUsg: stackRows[0]?.productCostPerUsg ?? null,
    totalLandedCostPerUsg: stackRows[0]?.totalLandedCostPerUsg ?? null,
    sellPricePerUsg: scenario?.sellPricePerUsg ?? null,
    scenarioRecommendation: results.scorecard?.recommendation ?? null,
  };
}

const GENERATOR_SYSTEM_PROMPT = `You are a commodity trading deal-room assistant for an
operator (a broker/principal) working on a single fuel deal. Your job is to produce a
"Revenue Assumption Map": the small set of facts that must be true for this deal to
become real revenue, along with the fastest test for each.

Produce STRICT JSON: an array of 6-10 objects with exactly these fields:
  - assumptionType: one of the 10 enum values (see below)
  - assumptionText: one sentence, plain English, what must be true
  - confidenceScore: integer 0-100, your current confidence the assumption is TRUE given the context
  - fastestTest: one sentence, the cheapest concrete action the operator can take to confirm or disprove
  - riskIfFalse: one sentence, what kills the deal if this turns out to be false
  - recommendedActionType: one of the procur ActionDescriptor kinds when a test maps cleanly
    ('email.send', 'sms.send', 'whatsapp.send', 'outbound_call', 'sanctions.screen',
    'follow_up.schedule', 'crm.create_company', 'crm.create_contact'); null when no
    automated action fits

Assumption types (taxonomy — use each at most once):
  authority, availability, price, payment, compliance, bankability, logistics,
  commercial_protection, timing, relationship_access

Hard rules:
1. Treat the deal as a HYPOTHESIS, not a conclusion. Be honest about confidence —
   if the evidence is thin, score 30-50, not 80.
2. fastestTest must be CONCRETE and CHEAP. "Run a thorough KYC review" is bad;
   "Email the procurement contact and ask whether their team reviews third-party
   originated supply" is good.
3. Never recommend disclosing buyer or seller identity until commercial_protection
   (NDA + fee-protection) is confirmed. The compliance/commercial_protection
   assumptions should reflect this.
4. If disclosure_allowed is false in the context, ALWAYS include
   commercial_protection as the #1 (highest impact) assumption.
5. Output JSON only — no prose preamble, no markdown fences.`;

function buildPrompt(c: FuelDealContext): string {
  return [
    `Deal: ${c.dealRef} (${c.product}, ${c.volumeUsg.toLocaleString()} USG, ${c.incoterm.toUpperCase()})`,
    `Buyer: ${c.buyerLegalName ?? c.buyerOrgId ?? 'unknown'}`,
    `Destination: ${c.destinationPort ?? 'unspecified'}`,
    `Payment terms: ${c.paymentTerms}`,
    '',
    `disclosure_allowed: ${c.disclosureAllowed} (false = MUST tee up commercial_protection first)`,
    `NDA: ${c.ndaSignedAt ? 'signed ' + c.ndaSignedAt.toISOString().slice(0, 10) : 'NOT signed'}`,
    `Fee protection: ${c.feeProtectionStatus ?? 'NOT set'}`,
    '',
    `OFAC screen: ${c.ofacScreeningStatus}`,
    `Compliance hold: ${c.complianceHold ? 'YES' : 'no'}`,
    '',
    c.productCostPerUsg != null
      ? `Cost stack: $${c.productCostPerUsg.toFixed(4)}/USG product, total landed $${c.totalLandedCostPerUsg?.toFixed(4) ?? '?'}/USG`
      : 'Cost stack: not populated',
    c.sellPricePerUsg != null
      ? `Active scenario sell: $${c.sellPricePerUsg.toFixed(4)}/USG`
      : 'No active scenario',
    c.scenarioRecommendation
      ? `Calculator verdict: ${c.scenarioRecommendation}`
      : 'No calculator verdict yet',
  ].join('\n');
}

function templateMap(reason: string): GenerateAssumptionMapResult {
  // Fixed-template fallback when LLM is unavailable. Operator-useful
  // (covers the 10-value taxonomy with sensible defaults) and flagged
  // `fromTemplate: true` so the UI can prompt a regenerate.
  const items: GeneratedAssumption[] = [
    {
      assumptionType: 'commercial_protection',
      assumptionText: 'NDA + fee-protection are in place before disclosing parties.',
      confidenceScore: 0,
      fastestTest: 'Send NDA / fee-protection agreement and request signature.',
      riskIfFalse: 'Counterparty circumvents and we lose the deal economics.',
      recommendedActionType: 'email.send',
    },
    {
      assumptionType: 'authority',
      assumptionText: "The contact has procurement / commercial authority for the buyer.",
      confidenceScore: 40,
      fastestTest:
        "Ask the contact to describe their procurement role and whether their desk reviews third-party originated supply.",
      riskIfFalse: 'We pitch into a non-decisionmaker and the deal stalls or leaks.',
      recommendedActionType: 'email.send',
    },
    {
      assumptionType: 'availability',
      assumptionText: 'The product is actually available at the claimed volume + spec.',
      confidenceScore: 50,
      fastestTest: 'Request POP / availability letter from seller side.',
      riskIfFalse: 'No real cargo behind the claim — broker chain or stale data.',
      recommendedActionType: 'email.send',
    },
    {
      assumptionType: 'price',
      assumptionText: 'Delivered economics are competitive vs current slate / benchmark.',
      confidenceScore: 50,
      fastestTest: 'Run the calculator with current freight + insurance estimates.',
      riskIfFalse: 'Margin evaporates after freight/finance/broker fees.',
      recommendedActionType: 'follow_up.schedule',
    },
    {
      assumptionType: 'payment',
      assumptionText: 'Payment route is bankable (LC/SBLC/escrow capability).',
      confidenceScore: 35,
      fastestTest: 'Ask the buyer about LC/SBLC/escrow capability before disclosing supplier.',
      riskIfFalse: 'No bankable instrument means we cannot deliver, full stop.',
      recommendedActionType: 'email.send',
    },
    {
      assumptionType: 'compliance',
      assumptionText: 'Sanctions / export-control route is acceptable.',
      confidenceScore: 50,
      fastestTest: 'Run sanctions screen on counterparties + product origin.',
      riskIfFalse: 'Counsel-gated issue or outright OFAC block.',
      recommendedActionType: 'sanctions.screen',
    },
    {
      assumptionType: 'logistics',
      assumptionText: 'Freight / discharge / laycan combination is feasible.',
      confidenceScore: 55,
      fastestTest: 'Confirm vessel availability + discharge capability with port agent.',
      riskIfFalse: 'Cargo cannot physically land within the laycan.',
      recommendedActionType: null,
    },
    {
      assumptionType: 'timing',
      assumptionText: 'The buyer\'s stated timing window is real, not aspirational.',
      confidenceScore: 50,
      fastestTest:
        'Ask the buyer for the next decision date + decision-maker name.',
      riskIfFalse: 'We invest in a deal that never moves.',
      recommendedActionType: 'email.send',
    },
  ];
  return {
    generatorVersion: GENERATOR_VERSION,
    assumptions: items,
    fromTemplate: true,
    contextSummary: reason,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    const cleaned = s
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function validateAssumptions(input: unknown): GeneratedAssumption[] | null {
  if (!Array.isArray(input)) return null;
  const out: GeneratedAssumption[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const t = r['assumptionType'];
    if (typeof t !== 'string' || !ASSUMPTION_TYPES.includes(t as AssumptionTypeValue)) {
      continue;
    }
    const text = r['assumptionText'];
    if (typeof text !== 'string' || text.length === 0) continue;
    const confRaw = r['confidenceScore'];
    const conf =
      typeof confRaw === 'number' ? Math.max(0, Math.min(100, Math.round(confRaw))) : 50;
    const fastestTest = typeof r['fastestTest'] === 'string' ? (r['fastestTest'] as string) : '';
    const riskIfFalse =
      typeof r['riskIfFalse'] === 'string' ? (r['riskIfFalse'] as string) : '';
    const action = r['recommendedActionType'];
    out.push({
      assumptionType: t as AssumptionTypeValue,
      assumptionText: text,
      confidenceScore: conf,
      fastestTest,
      riskIfFalse,
      recommendedActionType:
        typeof action === 'string' && action.length > 0 ? action : null,
    });
  }
  return out;
}

export const REVENUE_ASSUMPTION_GENERATOR_VERSION = GENERATOR_VERSION;
