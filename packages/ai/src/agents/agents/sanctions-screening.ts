import { eq } from 'drizzle-orm';
import {
  db,
  entitySanctionsScreens,
  events,
  organizations,
  signals,
} from '@procur/db';
import { createId } from '../id';
import type { ActionDescriptorT } from '../action-descriptor';
import type { AgentContext, AgentOutput, IAgent } from '../types';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 6. Screens a single
 * organization against US Consolidated Screening List + (optionally)
 * EU + UK OFSI feeds via the trade.gov CSL search API.
 *
 * Trigger: chat → `sanctions.screen` ActionDescriptor → operator
 * approves → the sanctions executor invokes AgentRunner.run(this).
 *
 * Lifecycle:
 *   1. Fetch the organization row
 *   2. Call trade.gov CSL search API (when CSL_API_KEY is set)
 *      against the org's legal_name. Without an API key, the agent
 *      records `manual_review_required` so the operator can resolve
 *      manually — never blocks on missing config.
 *   3. Apply fuzzy threshold: ≥0.95 = high_confidence,
 *      0.85-0.95 = fuzzy_review, <0.85 = filtered out
 *   4. Write a row to entity_sanctions_screens (Phase 1 schema —
 *      append-only, idempotent on (vex_tenant_id, screen_id))
 *   5. Update organizations.ofac_status + ofac_highest_score for
 *      fast-path UI lookups
 *   6. Fire a `signals` row at critical severity when status is
 *      potential_match or confirmed_match (so the inbox surfaces it)
 *   7. Emit `entity.sanctions_screened` audit event
 *
 * Tier T1: writes operator-visible artifacts but doesn't dispatch
 * outbound action on its own. The deal evaluator (Phase 5) reads
 * the org's ofac_status + the deal-level compliance flags and
 * decides whether to block the deal.
 */

const CSL_API_BASE = 'https://api.trade.gov/static/consolidated_screening_list';
const CSL_API_KEY = process.env.TRADE_GOV_CSL_API_KEY;
// Fuzzy match thresholds — matches vex's defaults.
const HIGH_CONFIDENCE_THRESHOLD = 0.95;
const FUZZY_REVIEW_THRESHOLD = 0.85;

interface CslSearchResult {
  results?: Array<{
    name: string;
    /** Source list code (e.g. "SDN", "EL", "DPL", "EU", "UK_OFSI"). */
    source: string;
    /** Match score 0-1; trade.gov returns the cosine score. */
    score?: number;
    /** Identifier in the source list. */
    source_list_url?: string;
    federal_register_notice?: string;
    programs?: string[];
    type?: string;
    addresses?: Array<Record<string, string>>;
  }>;
  total?: number;
}

interface ScreenMatch {
  source_list: string;
  sdn_uid: string;
  programs: string[];
  confidence_band: 'high_confidence' | 'fuzzy_review';
  sdn_type: string;
  matched_name: string;
  score: number;
}

export interface SanctionsScreeningInput {
  organizationId: string;
  /** Override: which lists to query. Default: ['us_csl']. */
  enabledLists?: Array<'us_csl' | 'eu' | 'uk_ofsi'>;
}

export class SanctionsScreeningAgent implements IAgent {
  readonly name = 'sanctions_screening';
  readonly tier = 'T1' as const;

  constructor(private readonly input: SanctionsScreeningInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const orgRows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, this.input.organizationId))
      .limit(1);
    const org = orgRows[0];
    if (!org) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        outputRefs: { skipped: 'org_not_found', org_id: this.input.organizationId },
        rationale: `org ${this.input.organizationId} not found`,
      };
    }

    const enabledLists = this.input.enabledLists ?? ['us_csl'];
    const screenedAt = ctx.now();
    const screenId = createId();

    // Run the actual screen. Fails open on network errors — records
    // a manual_review_required entry so the operator sees the gap.
    let status: 'clear' | 'potential_match' | 'confirmed_match' =
      'clear';
    let matches: ScreenMatch[] = [];
    let highestScore: number | null = null;
    let screenError: string | null = null;

    if (!CSL_API_KEY) {
      status = 'potential_match';
      screenError =
        'TRADE_GOV_CSL_API_KEY not configured; manual review required';
    } else {
      try {
        const cslMatches = await searchTradeGovCSL(org.legalName);
        matches = filterByThreshold(cslMatches, enabledLists);
        if (matches.length > 0) {
          highestScore = matches.reduce(
            (m, x) => Math.max(m, x.score),
            0,
          );
          status =
            highestScore >= HIGH_CONFIDENCE_THRESHOLD
              ? 'confirmed_match'
              : 'potential_match';
        }
      } catch (err) {
        status = 'potential_match';
        screenError =
          err instanceof Error ? err.message : 'unknown screen error';
      }
    }

    // Write the screen row. Phase 1 schema: append-only, dedup on
    // (vex_tenant_id, screen_id). vex_tenant_id is a leftover from
    // the vex-side semantics; in procur's single-user world we
    // stamp it with the agent_run_id for the same effect.
    await db
      .insert(entitySanctionsScreens)
      .values({
        id: createId(),
        entitySlug: org.id,
        vexTenantId: ctx.agentRunId,
        screenId,
        legalName: org.legalName,
        status,
        sourcesChecked: enabledLists.map((l) =>
          l === 'us_csl' ? 'SDN' : l === 'eu' ? 'EU' : 'UK_OFSI',
        ),
        matches: matches as unknown as Record<string, unknown>[],
        screenedAt,
        source: 'procur',
        ofacHighestScore: highestScore,
        ofacMatchCount: matches.length,
        ofacScreenedAt: screenedAt,
      })
      .onConflictDoNothing({
        target: [
          entitySanctionsScreens.vexTenantId,
          entitySanctionsScreens.screenId,
        ],
      });

    // Update organizations.ofac_status for fast-path UI lookups.
    await db
      .update(organizations)
      .set({
        ofacStatus: status === 'clear' ? 'clear' : status,
        ofacScreenedAt: screenedAt,
        ofacHighestScore: highestScore,
        updatedAt: ctx.now(),
      })
      .where(eq(organizations.id, org.id));

    // Fire a signal at critical severity when matched.
    if (status !== 'clear') {
      await db.insert(signals).values({
        id: createId(),
        ruleId: 'sanctions.match',
        severity: status === 'confirmed_match' ? 'critical' : 'warn',
        subjectType: 'organization',
        subjectId: org.id,
        title: `${org.legalName}: ${status.replace(/_/g, ' ')}`,
        body: screenError
          ? `Screen blocked: ${screenError}`
          : `Highest score ${highestScore?.toFixed(2)} across ${matches.length} match${matches.length === 1 ? '' : 'es'}.`,
        metadata: {
          screen_id: screenId,
          score: highestScore,
          match_count: matches.length,
          sources: enabledLists,
        },
      });
    }

    // Audit event.
    await db
      .insert(events)
      .values({
        id: createId(),
        verb: 'entity.sanctions_screened',
        subjectType: 'organization',
        subjectId: org.id,
        actorType: 'system',
        actorId: this.name,
        objectType: 'sanctions_screen',
        objectId: screenId,
        occurredAt: screenedAt,
        idempotencyKey: `sanctions.screen:${screenId}`,
        metadata: {
          status,
          highest_score: highestScore,
          match_count: matches.length,
          sources: enabledLists,
          error: screenError,
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    // Cost ledger — zero-cost for the deterministic path; the
    // network call to trade.gov is free for low-volume use.
    await ctx.costLedger.record({
      idempotencyKey: `sanctions_screening:${ctx.agentRunId}`,
      agentRunId: ctx.agentRunId,
      operation: 'web.search',
      provider: 'trade.gov.csl',
      units: 1,
      unitKind: 'queries',
      costUsdMicros: 0,
      occurredAt: screenedAt,
    });

    const proposedActions: ActionDescriptorT[] = [];
    // No T2/T3 follow-up emitted by this agent today. Future: when
    // status === 'confirmed_match' AND a deal references this org,
    // emit a `deal.status_change` proposed action to flip to failed.

    return {
      proposedActions,
      internalWrites: matches.length > 0 ? 4 : 3,
      costUsd: 0,
      outputRefs: {
        org_id: org.id,
        legal_name: org.legalName,
        status,
        highest_score: highestScore,
        match_count: matches.length,
        sources: enabledLists,
        ...(screenError ? { screen_error: screenError } : {}),
      },
      rationale: `${org.legalName}: ${status} (score ${highestScore?.toFixed(2) ?? 'n/a'}, ${matches.length} matches)`,
    };
  }
}

async function searchTradeGovCSL(name: string): Promise<ScreenMatch[]> {
  const url = `${CSL_API_BASE}/search?api_key=${encodeURIComponent(
    CSL_API_KEY!,
  )}&name=${encodeURIComponent(name)}&fuzzy_name=true&size=20`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`trade.gov CSL ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  const json = (await res.json()) as CslSearchResult;
  const out: ScreenMatch[] = [];
  for (const r of json.results ?? []) {
    const score = r.score ?? 0;
    if (score < FUZZY_REVIEW_THRESHOLD) continue;
    out.push({
      source_list: r.source ?? 'UNKNOWN',
      sdn_uid: r.source_list_url ?? r.federal_register_notice ?? r.name,
      programs: r.programs ?? [],
      confidence_band:
        score >= HIGH_CONFIDENCE_THRESHOLD ? 'high_confidence' : 'fuzzy_review',
      sdn_type: (r.type ?? 'entity').toLowerCase() as
        | 'individual'
        | 'entity'
        | 'vessel'
        | 'aircraft',
      matched_name: r.name,
      score,
    });
  }
  return out;
}

function filterByThreshold(
  matches: ScreenMatch[],
  enabledLists: string[],
): ScreenMatch[] {
  // trade.gov's `source` codes vary by list; map to our enabledLists.
  const allowedSources = new Set<string>();
  if (enabledLists.includes('us_csl')) {
    [
      'SDN',
      'NS-PLC',
      'SSI',
      'FSE',
      'DPL',
      'EL',
      'UVL',
      'MEU',
      'DTC',
      'ISN',
      'CAP',
    ].forEach((s) => allowedSources.add(s));
  }
  if (enabledLists.includes('eu')) allowedSources.add('EU');
  if (enabledLists.includes('uk_ofsi')) allowedSources.add('UK_OFSI');
  return matches.filter((m) => allowedSources.has(m.source_list));
}
