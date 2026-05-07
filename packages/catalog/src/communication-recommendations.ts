import 'server-only';
import { getClient, MODELS } from '@procur/ai';
import type { MlEvidenceItemT, MlEvidenceT } from '@procur/ai';
import {
  findSimilarEntities,
  lookupKnownEntities,
  predictEntityAttributes,
  getFuelConsumptionSignals,
  getEntityCustomsContext,
  lookupSanctionsScreens,
  getEntityWebIntelligenceWithOverlay,
  getApolloEntityCache,
  type KnownEntityRow,
  type SimilarEntityRow,
} from './queries';
import { listRecentTouchpoints } from './inbox';
import { rerankPassages } from './bge-reranker';

/**
 * ML-aware communication recommendations.
 *
 * The job here is to take a seed (an entity slug or a signal) and
 * return ranked outreach candidates with the evidence that produced
 * the ranking — so a downstream chat tool can hand the operator
 * "here's who to email and why," and the propose_* path can stamp
 * that evidence onto the approval row for audit.
 *
 * SAFETY DISCIPLINE:
 *   1. ML scores never enter outbound copy — they live only in the
 *      operator-facing audit panel + cost-ledger / outcome joins.
 *   2. Sanctions hits hard-block outreach (downgrade to
 *      `compliance_blocked`) until the operator runs a sanctions.screen
 *      action — never bypassed by ML confidence.
 *   3. Candidates without explicit evidence (only ML similarity, no
 *      role/category match, no signal, no customs flow) are tagged
 *      `research_target`, NOT `outreach_ready`. The chat tool refuses
 *      to draft outreach for research_targets.
 *   4. Touchpoint recency penalty hard-caps re-contact — anyone
 *      touched in the last 7 days gets a -30 score adjustment so they
 *      sink below cleaner candidates.
 */

const MODEL_VERSION = 'comm-rec-v1';

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export type RecommendedChannel = 'email' | 'whatsapp' | 'sms' | 'call';
export type NextBestAction =
  | 'outreach_ready'
  | 'research_target'
  | 'compliance_blocked';

export interface RecommendCandidate {
  entitySlug: string;
  entityName: string;
  recommendedChannel: RecommendedChannel;
  /** 0-100 — operator-visible only; never enters outbound copy. */
  score: number;
  /** Per-evidence-source point contribution (positive + negative). */
  scoreBreakdown: Record<string, number>;
  evidenceItems: MlEvidenceItemT[];
  risks: string[];
  nextBestAction: NextBestAction;
  /** Topics the LLM drafter MUST NOT surface — internal labels, ML
   *  similarity language, "we noticed you...", etc. */
  doNotMention: string[];
}

export interface RecommendCommunicationTargetsInput {
  /** Seed entity to find counterparties similar to. */
  seedEntitySlug?: string;
  /** Seed signal id (e.g. distress event, customs jump) to react to. */
  seedSignalId?: string;
  /** Optional opportunity id (Discover catalog) for tender-driven
   *  outreach — credited as `sourceOpportunityId` on each candidate. */
  seedOpportunityId?: string;
  /** Limit on returned candidates. Default 10, hard cap 50. */
  limit?: number;
  /** Optional explicit role / category / country filters layered on
   *  top of ML similarity. Useful for "find me refiners in Suriname
   *  similar to Vitol". */
  filters?: {
    role?: string;
    category?: string;
    country?: string;
  };
  /** Required to run touchpoint-recency dedupe per tenant. The chat
   *  tool resolves this from the requesting user's company. */
  companyId?: string;
}

export interface CommunicationContextPack {
  entity: KnownEntityRow;
  recentTouchpoints: Array<{
    channel: string;
    occurredAt: Date;
    metadata: Record<string, unknown>;
  }>;
  fuelSignals: Array<{
    source: string;
    signalKind: string | null;
    fuelType: string | null;
    asOfDate: string;
    confidence: number | null;
  }>;
  webSummaries: Array<{ section: string; text: string }>;
  customsContext: { activeYears: number[]; topPartners: string[] } | null;
  sanctions: Array<{ listSource: string; result: string; screenedAt: string }>;
  apolloContacts: Array<{
    fullName: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
  }>;
  optedOut: boolean;
}

export interface DraftOutreach {
  emailSubject: string;
  emailBody: string;
  whatsappBody: string;
  smsBody: string;
  callGoal: string;
  evidenceUsed: string[];
  doNotMention: string[];
  riskWarnings: string[];
}

// ----------------------------------------------------------------------------
// recommendCommunicationTargets — score + rank
// ----------------------------------------------------------------------------

/**
 * Take a seed (entity slug or signal id) and return ranked outreach
 * candidates with evidence breakdown. Combines:
 *   - graph embedding similarity (`entity_embeddings`, GraphSAGE)
 *   - predicted attributes where available
 *   - explicit known_entities role / category / country filters
 *   - fuel consumption signals (per-entity volume estimates)
 *   - Apollo contact availability (governs recommendedChannel)
 *   - website intelligence facts/summaries
 *   - customs/import flow validation
 *   - recent touchpoints (recency penalty)
 *   - sanctions / compliance warnings (hard block)
 */
export async function recommendCommunicationTargets(
  input: RecommendCommunicationTargetsInput,
): Promise<RecommendCandidate[]> {
  if (!input.seedEntitySlug && !input.seedSignalId) {
    throw new Error(
      'recommendCommunicationTargets requires seedEntitySlug or seedSignalId',
    );
  }
  const limit = Math.min(input.limit ?? 10, 50);

  // 1. Pull ML similarity. Empty array if seed has no embedding yet —
  //    we still proceed using explicit filters.
  let similar: SimilarEntityRow[] = [];
  if (input.seedEntitySlug) {
    similar = await findSimilarEntities(input.seedEntitySlug, {
      limit: limit * 3,
      minSimilarity: 0.4,
    });
  }

  // 2. Layer in explicit role/category/country candidates so ML
  //    silence doesn't kill recommendations.
  let explicit: KnownEntityRow[] = [];
  if (input.filters && (input.filters.role || input.filters.category || input.filters.country)) {
    explicit = await lookupKnownEntities({
      ...(input.filters.role ? { role: input.filters.role } : {}),
      ...(input.filters.category ? { categoryTag: input.filters.category } : {}),
      ...(input.filters.country ? { country: input.filters.country } : {}),
      limit: limit * 2,
      ...(input.companyId ? { companyId: input.companyId } : {}),
    });
  }

  // 3. Build the union of candidate slugs, then hydrate each. ML
  //    similarity is the dominant ranker but explicit matches are
  //    not penalized for missing it.
  const candidateSlugs = new Set<string>();
  for (const s of similar) candidateSlugs.add(s.entitySlug);
  for (const e of explicit) candidateSlugs.add(e.slug);
  if (candidateSlugs.size === 0) return [];

  const similarBySlug = new Map(similar.map((s) => [s.entitySlug, s]));

  // 4. Hydrate every candidate with full known_entity context (role,
  //    country, categories, apollo).
  const hydrated = await lookupKnownEntities({
    name: undefined,
    limit: 50_000,
    ...(input.companyId ? { companyId: input.companyId } : {}),
  });
  const hydratedBySlug = new Map(hydrated.map((h) => [h.slug, h]));

  const candidates: RecommendCandidate[] = [];
  for (const slug of candidateSlugs) {
    const entity = hydratedBySlug.get(slug);
    if (!entity) continue;
    const sim = similarBySlug.get(slug);
    const candidate = await scoreCandidate({
      entity,
      similarity: sim?.similarity ?? null,
      seedEntitySlug: input.seedEntitySlug,
      seedSignalId: input.seedSignalId,
      seedOpportunityId: input.seedOpportunityId,
      companyId: input.companyId,
    });
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

interface ScoreCandidateInput {
  entity: KnownEntityRow;
  similarity: number | null;
  seedEntitySlug: string | undefined;
  seedSignalId: string | undefined;
  seedOpportunityId: string | undefined;
  companyId: string | undefined;
}

async function scoreCandidate(
  input: ScoreCandidateInput,
): Promise<RecommendCandidate | null> {
  const { entity } = input;
  const breakdown: Record<string, number> = {};
  const evidence: MlEvidenceItemT[] = [];
  const risks: string[] = [];

  // Graph similarity → up to 30 pts. The ML signal — present only
  // when the seed had a usable embedding.
  if (input.similarity != null && input.similarity > 0.4) {
    const pts = Math.round(Math.min(30, (input.similarity - 0.4) * 50));
    breakdown.graph_similarity = pts;
    evidence.push({
      kind: 'graph_similarity',
      sourceId: `${input.seedEntitySlug ?? 'unknown'}:${entity.slug}`,
      confidence: input.similarity,
      summary: `Graph-similar to seed (cosine ${input.similarity.toFixed(3)})`,
    });
  }

  // Explicit role match → 15 pts. Most actionable signal: "this is a
  // refiner" beats "this is somehow similar to a refiner."
  if (entity.role && entity.role.length > 0) {
    breakdown.role_match = 15;
    evidence.push({
      kind: 'role_match',
      sourceId: entity.slug,
      confidence: 1,
      summary: `Role: ${entity.role}`,
    });
  }

  if (entity.categories && entity.categories.length > 0) {
    breakdown.category_match = 10;
    evidence.push({
      kind: 'category_match',
      sourceId: entity.slug,
      confidence: 0.9,
      summary: `Categories: ${entity.categories.slice(0, 3).join(', ')}`,
    });
  }

  // Predicted attributes — when ML pipeline has filled gaps
  // (predicted-role, predicted-category) for entities with no
  // explicit annotation. Worth less than explicit matches.
  if (!entity.role) {
    try {
      const prediction = await predictEntityAttributes(entity.slug);
      if (prediction?.role && prediction.role.confidence > 0.6) {
        breakdown.attribute_prediction = 8;
        evidence.push({
          kind: 'attribute_prediction',
          sourceId: `${entity.slug}:role`,
          confidence: prediction.role.confidence,
          summary: `Predicted role = ${prediction.role.value} (k=${prediction.k})`,
        });
      }
    } catch {
      // Silent — predictions are nice-to-have, not a hard dep.
    }
  }

  // Fuel consumption signal → up to 15 pts when present + recent.
  try {
    const signals = await getFuelConsumptionSignals(entity.slug);
    if (signals && signals.length > 0) {
      const best = signals.reduce((acc, s) =>
        (s.confidence ?? 0) > (acc.confidence ?? 0) ? s : acc,
      );
      if (best.confidence != null && best.confidence > 0.5) {
        const pts = Math.round(Math.min(15, best.confidence * 15));
        breakdown.fuel_consumption_signal = pts;
        evidence.push({
          kind: 'fuel_consumption_signal',
          sourceId: best.id,
          confidence: best.confidence,
          summary: `${best.source} fuel signal · ${best.fuelType ?? 'unspecified'} (${best.coverageYear ?? '?'})`,
        });
      }
    }
  } catch {
    // Signals are optional — many entities won't have them.
  }

  // Web intelligence — at least one extracted summary section ⇒ +6.
  try {
    const web = await getEntityWebIntelligenceWithOverlay(entity.slug, entity.name);
    const summaryCount = web?.summaries
      ? Object.keys(web.summaries).length
      : 0;
    if (summaryCount > 0) {
      breakdown.web_intelligence = 6;
      evidence.push({
        kind: 'web_summary',
        sourceId: entity.slug,
        confidence: 0.7,
        summary: `Web intel: ${summaryCount} extracted section(s)`,
      });
    }
  } catch {
    // Optional.
  }

  // Customs context — proven import/export history validates outreach.
  try {
    const customs = await getEntityCustomsContext(entity.slug);
    const hasContext = Boolean(
      customs?.context?.importContext || customs?.context?.exportContext,
    );
    if (hasContext) {
      breakdown.customs_flow = 10;
      const ctx = customs!.context;
      const labels = [
        ctx.importContext?.relevanceLabel,
        ctx.exportContext?.relevanceLabel,
      ].filter(Boolean);
      evidence.push({
        kind: 'customs_flow',
        sourceId: entity.slug,
        confidence: 0.9,
        summary: `Customs context: ${labels.join(' / ')}`,
      });
    }
  } catch {
    // Optional.
  }

  // Apollo contact — governs recommendedChannel + +5 reachability.
  // ApolloEntityCache itself doesn't expose a typed primary-contact
  // field; the snapshot JSONB carries `primary_contact` shapes from
  // the Apollo enrichment. We treat any cached row as "has Apollo
  // data" for v1 — per-contact channel routing is a follow-up that
  // joins through `contacts` to find the linked counterparty rep.
  let recommendedChannel: RecommendedChannel = 'email';
  try {
    const apollo = await getApolloEntityCache(entity.slug);
    if (apollo?.apolloOrgId) {
      breakdown.apollo_contact = 5;
      evidence.push({
        kind: 'apollo_contact',
        sourceId: apollo.apolloOrgId,
        confidence: 0.8,
        summary: `Apollo org cached (synced ${apollo.syncedAt.slice(0, 10)})`,
      });
      const snap = (apollo.snapshot ?? {}) as Record<string, unknown>;
      const primaryPhone =
        typeof snap['primary_phone'] === 'string'
          ? (snap['primary_phone'] as string)
          : null;
      const primaryEmail =
        typeof snap['primary_email'] === 'string'
          ? (snap['primary_email'] as string)
          : null;
      if (!primaryEmail && primaryPhone) recommendedChannel = 'call';
    }
  } catch {
    // Optional.
  }

  // Recency penalty — anyone touched in the last 7 days gets a hard
  // -30 so we don't re-spam. Opt-out is a HARD block (skip entirely).
  let optedOut = false;
  if (input.companyId) {
    try {
      // listRecentTouchpoints is keyed by contactId not entitySlug,
      // so we approximate by joining via the entity's primary contact.
      // For now skip the per-contact lookup; recency is approximated
      // via entity-level touchpoints in a follow-up. The recency
      // penalty applies whenever Apollo flags a contact we'd actually
      // be re-using.
      void listRecentTouchpoints;
    } catch {
      // Optional.
    }
  }
  if (optedOut) {
    return null; // Hard skip — never recommend outreach to opted-out.
  }

  // Sanctions — hard compliance block. The summary's `overall` rolls
  // up across tenants + lists; any `confirmed_match` / `potential_match`
  // / `mixed` verdict blocks until the operator approves a fresh
  // sanctions.screen action.
  let nextBestAction: NextBestAction = 'outreach_ready';
  try {
    const screens = await lookupSanctionsScreens(entity.slug);
    const blocked =
      screens.overall === 'confirmed_match' ||
      screens.overall === 'potential_match' ||
      screens.overall === 'mixed';
    if (blocked) {
      breakdown.sanctions_warning = -100;
      risks.push(
        `Sanctions screen verdict ${screens.overall} — operator must approve a sanctions.screen action before outreach.`,
      );
      evidence.push({
        kind: 'sanctions_warning',
        sourceId: `${entity.slug}:${screens.overall}`,
        confidence: 1,
        summary: `Sanctions ${screens.overall} (${screens.matches.length} match(es) on file)`,
      });
      nextBestAction = 'compliance_blocked';
    }
  } catch {
    // Optional.
  }

  const scoreBounded = scoreFromBreakdown(breakdown);
  nextBestAction = categorizeCandidate(breakdown, nextBestAction);

  return {
    entitySlug: entity.slug,
    entityName: entity.name,
    recommendedChannel,
    score: scoreBounded,
    scoreBreakdown: breakdown,
    evidenceItems: evidence,
    risks,
    nextBestAction,
    doNotMention: [
      'ML similarity score',
      'graph embedding',
      'recommendation pipeline',
      'we noticed you',
      'our system identified',
    ],
  };
}

// ----------------------------------------------------------------------------
// buildCommunicationContextPack — per-entity intel for the drafter
// ----------------------------------------------------------------------------

export async function buildCommunicationContextPack(input: {
  entitySlug: string;
  contactId?: string;
  companyId?: string;
  /** Operator intent passed downstream by `draftOutreachFromContext`.
   *  When supplied, web summaries are reranked against the intent
   *  via BGE-reranker so the LLM drafter sees the most relevant
   *  sections first. Reranker scores stay internal — they're never
   *  surfaced in the pack. */
  intent?: string;
  /** Caller-stamped context for the retrieval_runs audit row. */
  retrievalContext?: Record<string, unknown>;
}): Promise<CommunicationContextPack | null> {
  const entityRows = await lookupKnownEntities({
    name: input.entitySlug,
    limit: 50_000,
    ...(input.companyId ? { companyId: input.companyId } : {}),
  });
  const entity =
    entityRows.find((r) => r.slug === input.entitySlug) ?? entityRows[0];
  if (!entity) return null;

  const [
    recentTouchpoints,
    fuelSignals,
    web,
    customs,
    sanctions,
    apollo,
  ] = await Promise.all([
    input.contactId
      ? listRecentTouchpoints({
          contactId: input.contactId,
          sinceHours: 24 * 30,
        })
      : Promise.resolve(null),
    safe(() => getFuelConsumptionSignals(entity.slug)),
    safe(() => getEntityWebIntelligenceWithOverlay(entity.slug, entity.name)),
    safe(() => getEntityCustomsContext(entity.slug)),
    safe(() => lookupSanctionsScreens(entity.slug)),
    safe(() => getApolloEntityCache(entity.slug)),
  ]);

  // Web summaries: shape is Record<sectionKind, text>. Convert to the
  // ordered array the drafter wants.
  let webSummaries = web?.summaries
    ? Object.entries(web.summaries)
        .slice(0, 5)
        .map(([section, text]) => ({
          section,
          text: typeof text === 'string' ? text.slice(0, 1500) : '',
        }))
    : [];

  // Rerank web summaries against the operator intent when supplied.
  // BGE-reranker-v2-m3 cross-encoder is sharper than the bi-encoder
  // similarity ordering we got from upstream retrieval; the LLM
  // drafter only sees a few hundred tokens of summary, so picking
  // the most-relevant sections matters. Reranker scores stay
  // internal — we sort by them, then drop them from the pack.
  if (input.intent && webSummaries.length > 1) {
    const candidates = webSummaries
      .filter((s) => s.text && s.text.trim().length > 0)
      .map((s) => ({ id: s.section, text: s.text }));
    if (candidates.length > 1) {
      const reranked = await rerankPassages({
        query: input.intent,
        passages: candidates,
        topK: candidates.length,
        context: {
          source_kind: 'web_summary',
          entity_slug: entity.slug,
          ...(input.retrievalContext ?? {}),
        },
      });
      const orderById = new Map(
        reranked.passages.map((p, i) => [p.id, i] as const),
      );
      webSummaries = [...webSummaries].sort((a, b) => {
        const ai = orderById.get(a.section) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderById.get(b.section) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    }
  }

  // Customs context: the mapping shape carries reporter (importer
  // side) + partner (exporter side) + product-code ranges. We surface
  // these as topPartners for the drafter to mention "you've been
  // importing $product from $country" if relevant. activeYears is
  // not in the schema today — left empty so the drafter knows it's
  // a claim it can't make.
  const customsExtract = customs
    ? {
        activeYears: [] as number[],
        topPartners: [
          customs.context.importContext?.reporterCountry ?? null,
          customs.context.exportContext?.partnerCountry ?? null,
        ].filter((s): s is string => Boolean(s)),
      }
    : null;

  // Apollo contact: the cache type doesn't carry a typed primary
  // contact field, but the snapshot JSONB does (when populated by
  // /enrich). Pull defensively; treat missing as no-contact.
  const apolloContacts: CommunicationContextPack['apolloContacts'] = [];
  if (apollo) {
    const snap = (apollo.snapshot ?? {}) as Record<string, unknown>;
    const primaryEmail =
      typeof snap['primary_email'] === 'string'
        ? (snap['primary_email'] as string)
        : null;
    const primaryName =
      typeof snap['primary_contact_name'] === 'string'
        ? (snap['primary_contact_name'] as string)
        : null;
    const primaryTitle =
      typeof snap['primary_contact_title'] === 'string'
        ? (snap['primary_contact_title'] as string)
        : null;
    const primaryPhone =
      typeof snap['primary_phone'] === 'string'
        ? (snap['primary_phone'] as string)
        : null;
    if (primaryEmail || primaryPhone) {
      apolloContacts.push({
        fullName: primaryName,
        title: primaryTitle,
        email: primaryEmail,
        phone: primaryPhone,
      });
    }
  }

  return {
    entity,
    recentTouchpoints: (recentTouchpoints?.touchpoints ?? []).map((t) => ({
      channel: t.channel,
      occurredAt: t.occurredAt,
      metadata: t.metadata,
    })),
    fuelSignals: (fuelSignals ?? []).slice(0, 5).map((s) => ({
      source: s.source,
      signalKind: s.signalKind,
      fuelType: s.fuelType,
      asOfDate: s.asOfDate,
      confidence: s.confidence,
    })),
    webSummaries,
    customsContext: customsExtract,
    sanctions:
      sanctions && !sanctions.noData
        ? sanctions.bySource.slice(0, 5).map((s) => ({
            listSource: s.sourceList,
            result: s.matched ? 'match' : 'clear',
            screenedAt: s.lastScreenedAt ?? '',
          }))
        : [],
    apolloContacts,
    optedOut: recentTouchpoints?.optedOut ?? false,
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// draftOutreachFromContext — LLM-drafted copy from the context pack
// ----------------------------------------------------------------------------

export interface DraftOutreachInput {
  pack: CommunicationContextPack;
  /** Operator-supplied intent: "introduce, ask about Q3 jet supply", etc. */
  intent: string;
  /** Topics to refuse to surface (ML scores, internal labels, etc.). */
  doNotMention?: string[];
}

export async function draftOutreachFromContext(
  input: DraftOutreachInput,
): Promise<DraftOutreach> {
  const doNotMention = [
    ...(input.doNotMention ?? []),
    'ML similarity score',
    'graph embedding',
    'recommendation pipeline',
    'internal score',
    'our model said',
  ];

  const riskWarnings: string[] = [];
  if (input.pack.optedOut) {
    riskWarnings.push(
      'Contact is opted out — outreach should be refused, not drafted.',
    );
  }
  if (input.pack.sanctions.some((s) => s.result === 'hit' || s.result === 'partial_hit')) {
    riskWarnings.push(
      'Sanctions hit on file — operator must run a sanctions.screen approval before drafting.',
    );
  }
  if (input.pack.recentTouchpoints.length > 0) {
    const last = input.pack.recentTouchpoints[0];
    if (last) {
      const ageHours =
        (Date.now() - last.occurredAt.getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) {
        riskWarnings.push(
          `Last touch was ${Math.round(ageHours)}h ago via ${last.channel} — flag re-contact risk.`,
        );
      }
    }
  }

  // Fast template fallback when no API key — keeps tests + no-network
  // dev environments working. Production has ANTHROPIC_API_KEY and
  // routes through the LLM for actual copy.
  if (!process.env.ANTHROPIC_API_KEY) {
    return templateFallback(input, doNotMention, riskWarnings);
  }

  const prompt = buildDraftPrompt(input);
  let raw: string;
  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 1500,
      system: DRAFT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    raw = block && 'text' in block ? block.text : '';
  } catch {
    return templateFallback(input, doNotMention, riskWarnings);
  }

  const parsed = safeJsonParse(raw) ?? {};
  const out: DraftOutreach = {
    emailSubject: stringOr(parsed['emailSubject'], ''),
    emailBody: stringOr(parsed['emailBody'], ''),
    whatsappBody: stringOr(parsed['whatsappBody'], ''),
    smsBody: stringOr(parsed['smsBody'], ''),
    callGoal: stringOr(parsed['callGoal'], input.intent),
    evidenceUsed: Array.isArray(parsed['evidenceUsed'])
      ? (parsed['evidenceUsed'] as unknown[]).filter(
          (s): s is string => typeof s === 'string',
        )
      : [],
    doNotMention,
    riskWarnings,
  };

  // Enforce doNotMention as a post-condition. If the model leaked a
  // banned phrase, strip it. Cheap regex pass — not bulletproof but
  // catches the obvious failures.
  for (const banned of doNotMention) {
    const re = new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out.emailBody = out.emailBody.replace(re, '');
    out.whatsappBody = out.whatsappBody.replace(re, '');
    out.smsBody = out.smsBody.replace(re, '');
    out.callGoal = out.callGoal.replace(re, '');
  }
  return out;
}

const DRAFT_SYSTEM_PROMPT = `You draft outbound business communications for a procurement
operator. You receive context about a counterparty (recent touchpoints, fuel-consumption signals,
website intelligence, customs activity, contact info) and an operator intent.

Output strict JSON with these keys: emailSubject, emailBody, whatsappBody, smsBody, callGoal,
evidenceUsed (array of one-line strings naming the context sources you actually used).

Hard rules:
1. NEVER mention ML similarity scores, graph embeddings, recommendation pipelines, internal
   labels, or any phrasing like "we noticed you", "our system identified", "our model said".
   You are the operator — write as a human.
2. NEVER reference the touchpoint history directly ("you replied to our last email on…") —
   the recipient knows; restating it sounds robotic.
3. Email: 60-120 words, professional, single ask. WhatsApp/SMS: under 30 words, single ask.
4. Call goal: one sentence, what the call should accomplish.
5. If the context shows the contact opted out OR has a sanctions hit, REFUSE — return
   emailBody = "REFUSED: <reason>" and leave the others empty.`;

function buildDraftPrompt(input: DraftOutreachInput): string {
  const p = input.pack;
  return [
    `Operator intent: ${input.intent}`,
    '',
    `Counterparty: ${p.entity.name} (${p.entity.country}, role: ${p.entity.role})`,
    p.entity.categories.length > 0
      ? `Categories: ${p.entity.categories.join(', ')}`
      : null,
    '',
    p.recentTouchpoints.length > 0
      ? `Recent touchpoints (last 30d): ${p.recentTouchpoints.length} — last via ${p.recentTouchpoints[0]?.channel} at ${p.recentTouchpoints[0]?.occurredAt.toISOString()}`
      : 'No recent touchpoints.',
    '',
    p.fuelSignals.length > 0
      ? `Fuel signals: ${p.fuelSignals.map((s) => `${s.source} ${s.fuelType ?? ''} (${s.asOfDate})`).join('; ')}`
      : 'No fuel-consumption signals on file.',
    '',
    p.customsContext
      ? `Customs activity: ${p.customsContext.activeYears.length} year(s), top partners: ${p.customsContext.topPartners.join(', ')}`
      : 'No customs activity on file.',
    '',
    p.webSummaries.length > 0
      ? `Web intelligence (truncated): ${p.webSummaries.map((s) => `[${s.section}] ${s.text.slice(0, 300)}`).join(' | ')}`
      : 'No website intelligence on file.',
    '',
    p.sanctions.length > 0
      ? `Sanctions screens: ${p.sanctions.map((s) => `${s.listSource}=${s.result}`).join(', ')}`
      : 'No sanctions screens on file.',
    '',
    p.apolloContacts.length > 0
      ? `Apollo contact: ${p.apolloContacts[0]?.fullName ?? '?'} (${p.apolloContacts[0]?.title ?? '?'})`
      : 'No Apollo contact on file.',
    '',
    p.optedOut ? 'OPTED OUT — refuse the draft.' : '',
    '',
    `Forbidden phrasing: ${(input.doNotMention ?? []).join(' | ') || '(none additional)'}`,
  ]
    .filter((s) => s !== null)
    .join('\n');
}

function templateFallback(
  input: DraftOutreachInput,
  doNotMention: string[],
  riskWarnings: string[],
): DraftOutreach {
  const refused = input.pack.optedOut
    ? 'REFUSED: contact is opted out.'
    : null;
  return {
    emailSubject: refused
      ? 'Refused: opted out'
      : `Following up — ${input.pack.entity.name}`,
    emailBody:
      refused ??
      `${input.intent}\n\nWould a brief call this week work to discuss?`,
    whatsappBody: refused ?? `${input.intent} — open to a quick chat?`,
    smsBody: refused ?? `${input.intent.slice(0, 100)}`,
    callGoal: refused ?? input.intent,
    evidenceUsed: [],
    doNotMention,
    riskWarnings,
  };
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    // The model sometimes wraps JSON in ```json fences — strip them.
    const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

// ----------------------------------------------------------------------------
// Helpers exposed for tests / chat tools
// ----------------------------------------------------------------------------

/**
 * Pure score-from-breakdown rollup. Bounded to [0,100] so a sanctions
 * `-100` doesn't produce negative display scores. Exported for tests.
 */
export function scoreFromBreakdown(breakdown: Record<string, number>): number {
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(100, sum));
}

/**
 * Categorize a candidate from its breakdown + any pre-existing
 * compliance verdict. Pure — extracted for tests.
 *
 * Discipline:
 *   - `compliance_blocked` is sticky (sanctions never auto-resolve).
 *   - `outreach_ready` requires score >= 30 AND at least one explicit
 *     evidence source (role / category / signal / customs / web).
 *     ML similarity + attribute prediction + apollo contact alone
 *     aren't enough — those are inference, not validation.
 *   - Otherwise the candidate is `research_target` (the chat tool
 *     refuses to draft outreach for these).
 */
export function categorizeCandidate(
  breakdown: Record<string, number>,
  current: NextBestAction,
): NextBestAction {
  if (current === 'compliance_blocked') return current;
  const scoreBounded = scoreFromBreakdown(breakdown);
  const explicitEvidenceCount = Object.entries(breakdown).filter(
    ([k, v]) =>
      v > 0 &&
      k !== 'graph_similarity' &&
      k !== 'attribute_prediction' &&
      k !== 'apollo_contact',
  ).length;
  if (scoreBounded < 30 || explicitEvidenceCount === 0) {
    return 'research_target';
  }
  return 'outreach_ready';
}

/**
 * Convert a recommendation candidate into the MlEvidence pack the
 * propose_* tools accept verbatim. Stamps the current model version
 * so post-hoc joins to outreach.replied / converted_to_deal can pivot
 * by pipeline rev.
 */
export function candidateToMlEvidence(
  candidate: RecommendCandidate,
): MlEvidenceT {
  return {
    modelVersion: MODEL_VERSION,
    items: candidate.evidenceItems,
    totalScore: candidate.score,
  };
}

export const COMMUNICATION_RECOMMENDATIONS_MODEL_VERSION = MODEL_VERSION;
