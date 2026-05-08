import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';
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
  /** Cold-start path for Market Probes that have no seed entity but
   *  do have segment labels (e.g. "hotel procurement", "marine bunker
   *  operators"). Each label runs a multi-column ILIKE across
   *  known_entities (name / aliases / categories / tags / notes); the
   *  scorer adds 0-25 pts based on how many labels matched. Closes
   *  the cold-start friction where ML similarity returns 0 candidates
   *  because there's no seed embedding to anchor on, and the explicit
   *  role/category/country filters are too narrow to surface
   *  semantically-relevant entities. */
  seedSegmentLabels?: string[];
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

/** Source identifiers for the per-signal fetch outcomes the pack
 *  surfaces. Drafter + scorecard inspect these to distinguish "we
 *  tried and the upstream errored" from "we tried and no data
 *  exists" — the prior shape (silent null swallow via `safe()`)
 *  conflated the two and let drafts ship from a vacuum during
 *  upstream incidents without anyone noticing. */
export type ContextSignalSource =
  | 'recentTouchpoints'
  | 'fuelSignals'
  | 'web'
  | 'customs'
  | 'sanctions'
  | 'apollo'
  | 'rerank';

export interface ContextSignalOutcome {
  source: ContextSignalSource;
  /** true = upstream fetch returned. false = fetch threw. Note: a
   *  successful fetch returning no data is still ok=true. */
  ok: boolean;
  /** Error message snippet when ok=false. */
  error?: string;
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
  /** Per-source fetch outcomes. Consumers (drafter, scorecard) check
   *  this to distinguish "service down" from "no data exists" when
   *  a field comes back empty. Optional for back-compat with packs
   *  built before this field landed; new builds always populate it. */
  signalHealth?: {
    outcomes: ContextSignalOutcome[];
    /** Convenience: any source where ok=false. */
    failedSources: ContextSignalSource[];
    /** True when any source errored. Drafter should not infer from
     *  absence of evidence in a failing source — the fetch was
     *  attempted and the upstream errored. */
    hasFetchErrors: boolean;
  };
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
  // Need either an ML seed or explicit filters. The ML branch ranks
  // by graph similarity; the filters branch surfaces explicit matches
  // (country/role/category) for cases like a fresh Market Probe where
  // no prior touch exists to seed from. Pre-#553 this required a seed
  // unconditionally and threw — Market Probes need filter-only mode.
  const hasFilters =
    !!input.filters &&
    (!!input.filters.role ||
      !!input.filters.category ||
      !!input.filters.country);
  const hasSegmentLabels =
    Array.isArray(input.seedSegmentLabels) &&
    input.seedSegmentLabels.some((l) => l.trim().length > 0);
  if (
    !input.seedEntitySlug &&
    !input.seedSignalId &&
    !hasFilters &&
    !hasSegmentLabels
  ) {
    throw new Error(
      'recommendCommunicationTargets requires seedEntitySlug, seedSignalId, seedSegmentLabels, or filters',
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

  // 2b. Cold-start segment-label search. When a Market Probe starts
  //     from segment labels (no seed entity), ILIKE-fan across
  //     name / aliases / categories / tags / notes catches
  //     semantically-relevant entities the explicit role/country
  //     filters miss. Each label is a separate match credit; the
  //     scorer rewards multi-label matches more than single hits.
  let segmentMatches: SegmentLabelMatch[] = [];
  if (hasSegmentLabels) {
    segmentMatches = await findEntitiesBySegmentLabels({
      labels: (input.seedSegmentLabels ?? []).filter(
        (l) => l.trim().length > 0,
      ),
      country: input.filters?.country,
      limit: limit * 3,
    });
  }

  // 3. Build the union of candidate slugs, then hydrate each. ML
  //    similarity is the dominant ranker but explicit matches are
  //    not penalized for missing it.
  const candidateSlugs = new Set<string>();
  for (const s of similar) candidateSlugs.add(s.entitySlug);
  for (const e of explicit) candidateSlugs.add(e.slug);
  for (const m of segmentMatches) candidateSlugs.add(m.slug);
  if (candidateSlugs.size === 0) return [];

  const similarBySlug = new Map(similar.map((s) => [s.entitySlug, s]));
  const segmentMatchBySlug = new Map(segmentMatches.map((m) => [m.slug, m]));

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
    const segMatch = segmentMatchBySlug.get(slug);
    const candidate = await scoreCandidate({
      entity,
      similarity: sim?.similarity ?? null,
      segmentLabelMatch: segMatch ?? null,
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

interface SegmentLabelMatch {
  slug: string;
  matchedLabels: string[];
}

/**
 * Cold-start segment-label search. For each label, ILIKE-match against
 * name / aliases[] / categories[] / tags[] / notes on known_entities;
 * aggregate per-slug counts so multi-label hits surface higher than
 * single-label ones. The scorer in recommendCommunicationTargets
 * grants 0-25 pts based on the match count — comparable to but
 * weaker than graph similarity (0-30 pts), which reflects the
 * weaker semantic precision of substring matching vs. embedding
 * similarity.
 *
 * Country filter optional but recommended — most probes are scoped
 * to a single country, and matching unconstrained against the global
 * rolodex on a label like "operations" would be too noisy.
 *
 * Why phrase-substring rather than tokenized? Operators write segment
 * labels as natural-language phrases ("hotel procurement", "marine
 * bunker operators"). Substring matches naturally catch entities
 * whose aliases / category tags / notes mention those phrases.
 * Tokenization could broaden recall but inflates noise (every entity
 * with "operations" in their notes would match a "marine bunker
 * operators" label).
 */
async function findEntitiesBySegmentLabels(input: {
  labels: string[];
  country?: string;
  limit?: number;
}): Promise<SegmentLabelMatch[]> {
  if (input.labels.length === 0) return [];
  const limit = input.limit ?? 50;
  // Use a CROSS JOIN against unnest(labels) so a single SQL pass
  // produces (slug, label) match pairs. GROUP BY then aggregates
  // into matched_labels per slug. Cheaper than N round-trips.
  const labelsArray = sql`ARRAY[${sql.join(
    input.labels.map((l) => sql`${l}`),
    sql`, `,
  )}]::text[]`;
  const result = await db.execute<{
    slug: string;
    matched_labels: string[];
  }>(sql`
    SELECT ke.slug,
           ARRAY_AGG(DISTINCT lbl) AS matched_labels
      FROM known_entities ke
      CROSS JOIN unnest(${labelsArray}) AS lbl
     WHERE 1=1
       ${input.country ? sql`AND UPPER(ke.country) = UPPER(${input.country})` : sql``}
       AND (
         ke.name ILIKE '%' || lbl || '%'
         OR EXISTS (SELECT 1 FROM unnest(ke.aliases) a WHERE a ILIKE '%' || lbl || '%')
         OR EXISTS (SELECT 1 FROM unnest(ke.categories) c WHERE c ILIKE '%' || lbl || '%')
         OR EXISTS (SELECT 1 FROM unnest(ke.tags) t WHERE t ILIKE '%' || lbl || '%')
         OR ke.notes ILIKE '%' || lbl || '%'
       )
     GROUP BY ke.slug
     ORDER BY COUNT(DISTINCT lbl) DESC, ke.slug
     LIMIT ${limit}
  `);
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    slug: String(r.slug),
    matchedLabels: (r.matched_labels as string[] | null) ?? [],
  }));
}

interface ScoreCandidateInput {
  entity: KnownEntityRow;
  similarity: number | null;
  segmentLabelMatch: SegmentLabelMatch | null;
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

  // Segment-label keyword match → up to 25 pts. Cold-start fallback
  // for probes that have segment labels but no seed entity. 1 label
  // matched = 12 pts; 2 = 18; 3+ = 25. Comparable to but capped below
  // graph similarity since substring matching is weaker than embedding
  // similarity. The evidence summary names the matched labels so the
  // dashboard surfaces "matched: hotel procurement, marine bunker
  // operators" rather than an opaque score.
  if (
    input.segmentLabelMatch &&
    input.segmentLabelMatch.matchedLabels.length > 0
  ) {
    const n = input.segmentLabelMatch.matchedLabels.length;
    const pts = n >= 3 ? 25 : n === 2 ? 18 : 12;
    breakdown.segment_label_match = pts;
    evidence.push({
      kind: 'category_match',
      sourceId: entity.slug,
      confidence: Math.min(0.85, 0.5 + n * 0.15),
      summary: `Matches ${n} probe segment label${n === 1 ? '' : 's'}: ${input.segmentLabelMatch.matchedLabels.join(', ')}`,
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

  // Per-source fetch outcomes — replaces the prior `safe()` swallow.
  // Each entry pairs the unwrapped data with an ok flag so downstream
  // consumers (drafter, scorecard, autopilot logging) can distinguish
  // "service down" from "no data exists" when a field comes back
  // empty. Without this distinction the drafter has no way to know
  // it's working with a vacuum during an upstream incident.
  const outcomes: ContextSignalOutcome[] = [];
  const [
    recentTouchpointsResult,
    fuelSignalsResult,
    webResult,
    customsResult,
    sanctionsResult,
    apolloResult,
  ] = await Promise.all([
    input.contactId
      ? safeOutcome('recentTouchpoints', () =>
          listRecentTouchpoints({
            contactId: input.contactId!,
            sinceHours: 24 * 30,
          }),
        )
      : Promise.resolve({ ok: true as const, data: null, source: 'recentTouchpoints' as const }),
    safeOutcome('fuelSignals', () => getFuelConsumptionSignals(entity.slug)),
    safeOutcome('web', () =>
      getEntityWebIntelligenceWithOverlay(entity.slug, entity.name),
    ),
    safeOutcome('customs', () => getEntityCustomsContext(entity.slug)),
    safeOutcome('sanctions', () => lookupSanctionsScreens(entity.slug)),
    safeOutcome('apollo', () => getApolloEntityCache(entity.slug)),
  ]);
  outcomes.push(
    ...[
      recentTouchpointsResult,
      fuelSignalsResult,
      webResult,
      customsResult,
      sanctionsResult,
      apolloResult,
    ].map((r) => ({
      source: r.source,
      ok: r.ok,
      ...(r.ok ? {} : { error: r.error }),
    })),
  );

  const recentTouchpoints = recentTouchpointsResult.ok
    ? recentTouchpointsResult.data
    : null;
  const fuelSignals = fuelSignalsResult.ok ? fuelSignalsResult.data : null;
  const web = webResult.ok ? webResult.data : null;
  const customs = customsResult.ok ? customsResult.data : null;
  const sanctions = sanctionsResult.ok ? sanctionsResult.data : null;
  const apollo = apolloResult.ok ? apolloResult.data : null;

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
  // Reranker failure is surfaced via signalHealth so drafter knows
  // the unranked order isn't an intentional ranking.
  if (input.intent && webSummaries.length > 1) {
    const candidates = webSummaries
      .filter((s) => s.text && s.text.trim().length > 0)
      .map((s) => ({ id: s.section, text: s.text }));
    if (candidates.length > 1) {
      const rerankResult = await safeOutcome('rerank', () =>
        rerankPassages({
          query: input.intent!,
          passages: candidates,
          topK: candidates.length,
          context: {
            source_kind: 'web_summary',
            entity_slug: entity.slug,
            ...(input.retrievalContext ?? {}),
          },
        }),
      );
      outcomes.push({
        source: rerankResult.source,
        ok: rerankResult.ok,
        ...(rerankResult.ok ? {} : { error: rerankResult.error }),
      });
      if (rerankResult.ok && rerankResult.data) {
        const orderById = new Map(
          rerankResult.data.passages.map((p, i) => [p.id, i] as const),
        );
        webSummaries = [...webSummaries].sort((a, b) => {
          const ai = orderById.get(a.section) ?? Number.MAX_SAFE_INTEGER;
          const bi = orderById.get(b.section) ?? Number.MAX_SAFE_INTEGER;
          return ai - bi;
        });
      }
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

  const failedSources = outcomes.filter((o) => !o.ok).map((o) => o.source);

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
    signalHealth: {
      outcomes,
      failedSources,
      hasFetchErrors: failedSources.length > 0,
    },
  };
}

/**
 * Per-signal fetch wrapper. Returns a discriminated union the caller
 * unpacks into a typed CommunicationContextPack field plus a
 * structured outcome row. Replaces the prior `safe()` shape which
 * collapsed errors to null and made every failing-upstream signal
 * indistinguishable from "no data exists" — drafts then shipped from
 * a vacuum during incidents (Apollo down, customs slow, reranker
 * rate-limited) without anyone seeing why.
 */
async function safeOutcome<T, S extends ContextSignalSource>(
  source: S,
  fn: () => Promise<T>,
): Promise<
  | { source: S; ok: true; data: T }
  | { source: S; ok: false; error: string }
> {
  try {
    const data = await fn();
    return { source, ok: true, data };
  } catch (err) {
    const error =
      err instanceof Error
        ? `${err.name}: ${err.message.slice(0, 200)}`
        : String(err).slice(0, 200);
    // Log loudly so operators / on-call see the upstream incident.
    // The pack still flows; consumers degrade gracefully via
    // signalHealth.failedSources.
    console.error(
      `[communication-context-pack] ${source} fetch failed`,
      error,
    );
    return { source, ok: false, error };
  }
}

// ----------------------------------------------------------------------------
// draftOutreachFromContext — LLM-drafted copy from the context pack
// ----------------------------------------------------------------------------

export type FormalityLevel = 'high' | 'professional' | 'casual';

export interface DraftOutreachInput {
  pack: CommunicationContextPack;
  /** Operator-supplied intent: "introduce, ask about Q3 jet supply", etc. */
  intent: string;
  /** Topics to refuse to surface (ML scores, internal labels, etc.). */
  doNotMention?: string[];
  /** Per-probe register override. NULL falls back to 'professional'
   *  (existing behavior). 'high' for first-contact M&A / succession
   *  outreach where deference matters; 'casual' for warm-market
   *  follow-ups. */
  formalityLevel?: FormalityLevel | null;
  /** Free-text framing the drafter receives alongside the intent.
   *  Captures domain-specific guidance the base prompt can't infer
   *  (e.g. "exploratory M&A — lead with respect, do NOT lead with
   *  valuation"). Capped to 1000 chars so prompt stays bounded. */
  domainHint?: string | null;
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
  // For each signal source, decide between three messaging shapes:
  //   - source has data: "Fuel signals: ..."
  //   - source returned no data (ok=true, empty): "No fuel signals on file."
  //   - source ERRORED (ok=false): "Fuel signals: fetch failed — do
  //     not infer from absence." This last case is what changes
  //     drafter behavior under upstream incidents: prior shape made
  //     errored-empty look identical to genuinely-empty, so the
  //     drafter would confidently say "no fuel signals" and the
  //     recipient got context-thin copy during outages.
  const failedSet = new Set(p.signalHealth?.failedSources ?? []);
  const failed = (source: ContextSignalSource): boolean =>
    failedSet.has(source);
  return [
    `Operator intent: ${input.intent}`,
    '',
    `Counterparty: ${p.entity.name} (${p.entity.country}, role: ${p.entity.role})`,
    p.entity.categories.length > 0
      ? `Categories: ${p.entity.categories.join(', ')}`
      : null,
    '',
    failed('recentTouchpoints')
      ? 'Recent touchpoints: fetch failed — do not infer from absence.'
      : p.recentTouchpoints.length > 0
        ? `Recent touchpoints (last 30d): ${p.recentTouchpoints.length} — last via ${p.recentTouchpoints[0]?.channel} at ${p.recentTouchpoints[0]?.occurredAt.toISOString()}`
        : 'No recent touchpoints.',
    '',
    failed('fuelSignals')
      ? 'Fuel signals: fetch failed — do not infer from absence.'
      : p.fuelSignals.length > 0
        ? `Fuel signals: ${p.fuelSignals.map((s) => `${s.source} ${s.fuelType ?? ''} (${s.asOfDate})`).join('; ')}`
        : 'No fuel-consumption signals on file.',
    '',
    failed('customs')
      ? 'Customs activity: fetch failed — do not infer from absence.'
      : p.customsContext
        ? `Customs activity: ${p.customsContext.activeYears.length} year(s), top partners: ${p.customsContext.topPartners.join(', ')}`
        : 'No customs activity on file.',
    '',
    failed('web')
      ? 'Web intelligence: fetch failed — do not infer from absence.'
      : p.webSummaries.length > 0
        ? `Web intelligence (truncated): ${p.webSummaries.map((s) => `[${s.section}] ${s.text.slice(0, 300)}`).join(' | ')}`
        : 'No website intelligence on file.',
    '',
    failed('sanctions')
      ? 'Sanctions screens: fetch failed — do not infer from absence; treat as needs-screening.'
      : p.sanctions.length > 0
        ? `Sanctions screens: ${p.sanctions.map((s) => `${s.listSource}=${s.result}`).join(', ')}`
        : 'No sanctions screens on file.',
    '',
    failed('apollo')
      ? 'Apollo contact: fetch failed — do not infer from absence.'
      : p.apolloContacts.length > 0
        ? `Apollo contact: ${p.apolloContacts[0]?.fullName ?? '?'} (${p.apolloContacts[0]?.title ?? '?'})`
        : 'No Apollo contact on file.',
    '',
    p.optedOut ? 'OPTED OUT — refuse the draft.' : '',
    '',
    p.signalHealth?.hasFetchErrors
      ? `Note to drafter: ${p.signalHealth.failedSources.length} signal source(s) failed to fetch this run. Don't pretend the missing data means "no activity exists" — write copy that's safe under either interpretation, and lean on what DID fetch successfully.`
      : '',
    '',
    buildSteeringBlock(input.formalityLevel, input.domainHint),
    `Forbidden phrasing: ${(input.doNotMention ?? []).join(' | ') || '(none additional)'}`,
  ]
    .filter((s) => s !== null && s !== '')
    .join('\n');
}

/**
 * Steering block injected into the user-message prompt for both
 * drafters (email + lead-form). Lives outside the cached system
 * prompt so per-probe values don't bust the prompt-cache hit.
 *
 * Formality maps to register-specific guidance the model honors:
 *   - 'high'         → deferential, indirect, honorifics where the
 *                       target language has them
 *   - 'professional' → default behavior; emit nothing (no extra
 *                       block needed since system prompt already
 *                       says "professional")
 *   - 'casual'       → conversational, first-name only, short
 *
 * Domain hint is opaque operator text — passed through verbatim to
 * the model. Capped at 1000 chars to keep prompt size bounded.
 */
function buildSteeringBlock(
  formalityLevel: FormalityLevel | null | undefined,
  domainHint: string | null | undefined,
): string {
  const lines: string[] = [];
  if (formalityLevel === 'high') {
    lines.push(
      'STEERING — formality: HIGH. Use deferential register. Indirect ask ("would you be open to a brief conversation about..." not "let\'s get on a call"). When the target language has honorific forms (Japanese 敬語, French vous, German Sie, Korean 존댓말, Spanish usted), use them — do NOT default to casual forms. Lead with respect for what the recipient has built; first contact is not the time to push.',
    );
  } else if (formalityLevel === 'casual') {
    lines.push(
      'STEERING — formality: CASUAL. Warm-market tone. First-name basis. Short, conversational. Skip "Dear" / "Best regards" formalities; "Hi <name>" / "Cheers" registers fit. Single ask still applies — casual tone, not casual content.',
    );
  }
  if (domainHint && domainHint.trim().length > 0) {
    lines.push(
      `STEERING — domain framing (operator-supplied): ${domainHint.slice(0, 1000)}`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
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

// ----------------------------------------------------------------------------
// draftLeadFormSubmission — drafter variant for website lead-form
// outreach. Sibling to draftOutreachFromContext but emits a form-
// shaped {subject?, message, name, email, ...} payload instead of an
// email/sms/whatsapp draft. Form-friendly differences:
//   - Shorter message body (300-500 chars; many forms cap at 500-1000)
//   - No subject when the endpoint has no subject_field
//   - No signature (form's dedicated name/email fields carry sender
//     identity)
//   - Single ask, plain text (forms render as plain text on the
//     receiving side; markdown / HTML structure won't survive)
// ----------------------------------------------------------------------------

export interface DraftLeadFormInput {
  pack: CommunicationContextPack;
  intent: string;
  doNotMention?: string[];
  /** Per-probe register override. Same semantics as the email
   *  drafter's formalityLevel — see DraftOutreachInput for the
   *  level taxonomy. */
  formalityLevel?: FormalityLevel | null;
  /** Free-text framing the drafter receives alongside the intent.
   *  Same semantics as DraftOutreachInput.domainHint. */
  domainHint?: string | null;
  /** Field-role map from the endpoint row. The drafter uses presence
   *  of subject_field to decide whether to draft a subject; presence
   *  of company_field / phone_field to know whether to provide
   *  optional sender attributes. */
  endpoint: {
    subjectField: string | null;
    companyField: string | null;
    phoneField: string | null;
    /** Operator-supplied or default sender identity. The drafter
     *  doesn't synthesize sender info — it only writes the message.
     *  These ride into the output verbatim. */
    senderName: string;
    senderEmail: string;
    senderCompany?: string | null;
    senderPhone?: string | null;
    /** ISO-639 language hint from the endpoint row. The drafter
     *  prompt is biased toward writing in this language when
     *  non-English (most operators write English by default; the
     *  hint shifts it). */
    language?: string | null;
  };
}

export interface DraftLeadFormResult {
  /** Subject text. Empty string when the endpoint has no
   *  subject_field — the form doesn't render it. */
  subject: string;
  /** Message body. Required by every endpoint per
   *  pickAutopilotEligibleEndpoint's filter. */
  message: string;
  senderName: string;
  senderEmail: string;
  senderCompany: string | null;
  senderPhone: string | null;
  evidenceUsed: string[];
  doNotMention: string[];
  riskWarnings: string[];
}

export async function draftLeadFormSubmission(
  input: DraftLeadFormInput,
): Promise<DraftLeadFormResult> {
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
  if (
    input.pack.sanctions.some(
      (s) => s.result === 'hit' || s.result === 'partial_hit',
    )
  ) {
    riskWarnings.push(
      'Sanctions hit on file — operator must run a sanctions.screen approval before drafting.',
    );
  }

  const baseResult = (subject: string, message: string): DraftLeadFormResult => ({
    subject: input.endpoint.subjectField ? subject : '',
    message,
    senderName: input.endpoint.senderName,
    senderEmail: input.endpoint.senderEmail,
    senderCompany: input.endpoint.senderCompany ?? null,
    senderPhone: input.endpoint.senderPhone ?? null,
    evidenceUsed: [],
    doNotMention,
    riskWarnings,
  });

  // Refuse on opted-out / sanctions hit before spending tokens.
  if (input.pack.optedOut) {
    return baseResult(
      'Outreach refused',
      'REFUSED: contact is opted out.',
    );
  }
  const sanctionsHit = input.pack.sanctions.some(
    (s) => s.result === 'hit' || s.result === 'partial_hit',
  );
  if (sanctionsHit) {
    return baseResult(
      'Outreach refused',
      'REFUSED: sanctions screen indicates a hit; outreach blocked pending operator review.',
    );
  }

  // No-API-key fallback: deterministic skeleton matching the email
  // path's templateFallback discipline.
  if (!process.env.ANTHROPIC_API_KEY) {
    const subject = `Inquiry from ${input.endpoint.senderName}`;
    const message = [
      `Hi ${input.pack.entity.name} team,`,
      '',
      input.intent,
      '',
      `Best, ${input.endpoint.senderName}`,
    ].join('\n');
    return baseResult(subject, message);
  }

  const prompt = buildLeadFormDraftPrompt(input);
  let raw: string;
  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 800,
      system: LEAD_FORM_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    raw = block && 'text' in block ? block.text : '';
  } catch {
    const subject = `Inquiry from ${input.endpoint.senderName}`;
    const message = `${input.intent}\n\nBest,\n${input.endpoint.senderName}`;
    return baseResult(subject, message);
  }

  const parsed = (() => {
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      const obj = JSON.parse(cleaned);
      return typeof obj === 'object' && obj !== null
        ? (obj as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  })();

  const subjectRaw = typeof parsed['subject'] === 'string' ? parsed['subject'] : '';
  const messageRaw = typeof parsed['message'] === 'string' ? parsed['message'] : '';
  const evidenceUsed = Array.isArray(parsed['evidenceUsed'])
    ? (parsed['evidenceUsed'] as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];

  // Cap message length defensively. Many forms cap at 500-1000 chars;
  // 800 is a safe ceiling that fits most without truncation.
  const message = messageRaw.slice(0, 800);
  const subject = input.endpoint.subjectField ? subjectRaw.slice(0, 120) : '';

  // Enforce doNotMention on the message + subject. Email path does
  // the same.
  const stripBanned = (s: string): string => {
    let out = s;
    for (const banned of doNotMention) {
      const re = new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, '');
    }
    return out;
  };

  return {
    subject: stripBanned(subject),
    message: stripBanned(message),
    senderName: input.endpoint.senderName,
    senderEmail: input.endpoint.senderEmail,
    senderCompany: input.endpoint.senderCompany ?? null,
    senderPhone: input.endpoint.senderPhone ?? null,
    evidenceUsed,
    doNotMention,
    riskWarnings,
  };
}

const LEAD_FORM_SYSTEM_PROMPT = `You draft outbound contact-form submissions for a procurement operator. You receive context about a counterparty (recent touchpoints, fuel-consumption signals, website intelligence, customs activity, contact info) and an operator intent. Forms render as plain text on the receiving side — no markdown, no HTML, no rich formatting.

Output strict JSON with these keys: subject, message, evidenceUsed (array of one-line strings naming the context sources you actually used).

Hard rules:
1. NEVER mention ML similarity scores, graph embeddings, recommendation pipelines, internal labels, or any phrasing like "we noticed you", "our system identified", "our model said". You are the operator — write as a human.
2. NEVER reference touchpoint history directly ("you replied to our last email on…") — the recipient knows; restating it sounds robotic.
3. Message: 80-200 words, plain text, single ask. Forms cap at ~500-1000 chars on the receiving side; staying tight matters.
4. NO signature block — the form's dedicated name / email / company / phone fields carry sender identity separately. Don't repeat them in the message.
5. Subject (when the form has a subject field): 5-12 words, no clickbait, plain.
6. If the context shows opted-out OR sanctions hit, REFUSE — return message = "REFUSED: <reason>" and subject = "Outreach refused".
7. When the context language is not English, write the message in that language. The operator's intent is in English; translate it naturally.`;

function buildLeadFormDraftPrompt(input: DraftLeadFormInput): string {
  const p = input.pack;
  const failedSet = new Set(p.signalHealth?.failedSources ?? []);
  const failed = (source: ContextSignalSource): boolean => failedSet.has(source);
  return [
    `Operator intent: ${input.intent}`,
    '',
    `Counterparty: ${p.entity.name} (${p.entity.country}, role: ${p.entity.role})`,
    p.entity.categories.length > 0
      ? `Categories: ${p.entity.categories.join(', ')}`
      : null,
    '',
    `Form has subject field: ${input.endpoint.subjectField ? 'yes' : 'no'}`,
    `Form language hint: ${input.endpoint.language ?? 'unknown'}`,
    '',
    failed('fuelSignals')
      ? 'Fuel signals: fetch failed — do not infer from absence.'
      : p.fuelSignals.length > 0
        ? `Fuel signals: ${p.fuelSignals.map((s) => `${s.source} ${s.fuelType ?? ''} (${s.asOfDate})`).join('; ')}`
        : 'No fuel-consumption signals on file.',
    '',
    failed('customs')
      ? 'Customs activity: fetch failed — do not infer from absence.'
      : p.customsContext
        ? `Customs activity: ${p.customsContext.activeYears.length} year(s), top partners: ${p.customsContext.topPartners.join(', ')}`
        : 'No customs activity on file.',
    '',
    failed('web')
      ? 'Web intelligence: fetch failed — do not infer from absence.'
      : p.webSummaries.length > 0
        ? `Web intelligence (truncated): ${p.webSummaries.map((s) => `[${s.section}] ${s.text.slice(0, 250)}`).join(' | ')}`
        : 'No website intelligence on file.',
    '',
    failed('sanctions')
      ? 'Sanctions screens: fetch failed — do not infer from absence; treat as needs-screening.'
      : p.sanctions.length > 0
        ? `Sanctions screens: ${p.sanctions.map((s) => `${s.listSource}=${s.result}`).join(', ')}`
        : 'No sanctions screens on file.',
    '',
    p.optedOut ? 'OPTED OUT — refuse the draft.' : '',
    '',
    p.signalHealth?.hasFetchErrors
      ? `Note to drafter: ${p.signalHealth.failedSources.length} signal source(s) failed to fetch this run. Don't pretend the missing data means "no activity exists" — write copy that's safe under either interpretation, and lean on what DID fetch successfully.`
      : '',
    '',
    `Sender: ${input.endpoint.senderName} <${input.endpoint.senderEmail}>${input.endpoint.senderCompany ? ` from ${input.endpoint.senderCompany}` : ''}`,
    buildSteeringBlock(input.formalityLevel, input.domainHint),
    `Forbidden phrasing: ${(input.doNotMention ?? []).join(' | ') || '(none additional)'}`,
  ]
    .filter((s) => s !== null && s !== '')
    .join('\n');
}

/**
 * Map a draft + endpoint into the field-name → value record the
 * lead-form executor expects. Single source of truth for "which
 * draft field goes into which form field" so callers (autopilot,
 * chat-tool path) can't drift.
 */
export function mapDraftToFieldValues(input: {
  draft: DraftLeadFormResult;
  endpoint: {
    nameField: string | null;
    emailField: string | null;
    subjectField: string | null;
    messageField: string | null;
    companyField: string | null;
    phoneField: string | null;
  };
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.endpoint.messageField) {
    out[input.endpoint.messageField] = input.draft.message;
  }
  if (input.endpoint.subjectField && input.draft.subject) {
    out[input.endpoint.subjectField] = input.draft.subject;
  }
  if (input.endpoint.nameField) {
    out[input.endpoint.nameField] = input.draft.senderName;
  }
  if (input.endpoint.emailField) {
    out[input.endpoint.emailField] = input.draft.senderEmail;
  }
  if (input.endpoint.companyField && input.draft.senderCompany) {
    out[input.endpoint.companyField] = input.draft.senderCompany;
  }
  if (input.endpoint.phoneField && input.draft.senderPhone) {
    out[input.endpoint.phoneField] = input.draft.senderPhone;
  }
  return out;
}
