import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  approvals,
  db,
  events,
  fuelDeals,
  leads,
  signals,
  summaries,
} from '@procur/db';
import { getClient, MODELS } from '../../client';
import { costUsdCentsForTurn } from '../../assistant/pricing';
import { createId } from '../id';
import type { AgentContext, AgentOutput, IAgent } from '../types';

/**
 * Per docs/vex-into-procur-merge-brief.md Phase 6. Assembles a
 * deterministic daily-brief snapshot from procur tables and asks
 * Sonnet to author a recommended-focus sentence + a one-paragraph
 * narrative greeting. Writes the JSON brief to the summaries table
 * with summary_type='daily_brief' so the /brief/today UI can render it.
 *
 * No external tool calls; everything assembled from rows already
 * in the DB. Lookback: last 24 hours of events + open approvals +
 * stale leads (5d+) + non-terminal deals.
 *
 * Tier: T1 — internal writes only, no outbound action.
 */

const LOOKBACK_HOURS = 24;
const STALE_LEAD_DAYS = 5;

const SYSTEM_PROMPT = `You are Procur's daily briefer.

You receive a JSON snapshot of yesterday's activity, today's open
approvals, stale leads, and active deal signals. Your job: produce
a concise greeting + a single recommended-focus sentence.

Hard rules:
- Greeting: one sentence, time-of-day appropriate, name-free.
- Recommended focus: one sentence, action-oriented, points at the
  highest-leverage item from the snapshot. If nothing material
  happened, say so plainly.
- Output JSON only, exactly:
  {
    "greeting": string,
    "recommendedFocus": string
  }
- Never invent items not in the snapshot.
`;

export interface DailyBriefInput {
  /** Optional override (testing). Default: now. */
  asOf?: Date;
}

export interface DailyBrief {
  generatedAt: string;
  greeting: string;
  recommendedFocus: string;
  pendingApprovalsCount: number;
  unacknowledgedSignalsCount: number;
  staleLeadsCount: number;
  activeDealsCount: number;
  topApprovals: Array<{
    id: string;
    actionType: string;
    createdAt: string;
    rationale: string | null;
  }>;
  topSignals: Array<{
    id: string;
    severity: string;
    title: string;
    createdAt: string;
  }>;
  riskyDeals: Array<{
    id: string;
    dealRef: string;
    status: string;
    complianceHold: boolean;
  }>;
  yesterdayAgentRuns: number;
  yesterdayCompletedAgentRuns: number;
}

export class DailyBriefAgent implements IAgent {
  readonly name = 'daily_brief';
  readonly tier = 'T1' as const;

  constructor(private readonly input: DailyBriefInput = {}) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    const asOf = this.input.asOf ?? ctx.now();
    const lookbackStart = new Date(
      asOf.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000,
    );
    const staleCutoff = new Date(
      asOf.getTime() - STALE_LEAD_DAYS * 24 * 60 * 60 * 1000,
    );

    // Aggregate snapshot from procur tables.
    const [
      pendingApprovalsRows,
      unacknowledgedSignalsRows,
      staleLeadsCountRows,
      activeDealsCountRows,
      topApprovals,
      topSignals,
      riskyDeals,
      yesterdayRuns,
    ] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(eq(approvals.decision, 'pending')),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(signals)
        .where(isNull(signals.acknowledgedAt)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .where(
          and(
            eq(leads.status, 'new'),
            sql`${leads.updatedAt} < ${staleCutoff}`,
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(fuelDeals)
        .where(
          sql`${fuelDeals.status} NOT IN ('settled', 'cancelled', 'failed')`,
        ),
      db
        .select({
          id: approvals.id,
          actionType: approvals.actionType,
          createdAt: approvals.createdAt,
          proposedPayload: approvals.proposedPayload,
        })
        .from(approvals)
        .where(eq(approvals.decision, 'pending'))
        .orderBy(desc(approvals.createdAt))
        .limit(5),
      db
        .select({
          id: signals.id,
          severity: signals.severity,
          title: signals.title,
          createdAt: signals.createdAt,
        })
        .from(signals)
        .where(isNull(signals.acknowledgedAt))
        .orderBy(desc(signals.createdAt))
        .limit(5),
      db
        .select({
          id: fuelDeals.id,
          dealRef: fuelDeals.dealRef,
          status: fuelDeals.status,
          complianceHold: fuelDeals.complianceHold,
        })
        .from(fuelDeals)
        .where(
          sql`${fuelDeals.complianceHold} = true OR ${fuelDeals.status} = 'failed'`,
        )
        .orderBy(desc(fuelDeals.updatedAt))
        .limit(5),
      db
        .select({
          status: agentRuns.status,
          count: sql<number>`count(*)::int`,
        })
        .from(agentRuns)
        .where(gte(agentRuns.createdAt, lookbackStart))
        .groupBy(agentRuns.status),
    ]);

    const pendingApprovalsCount = Number(pendingApprovalsRows[0]?.count ?? 0);
    const unacknowledgedSignalsCount = Number(
      unacknowledgedSignalsRows[0]?.count ?? 0,
    );
    const staleLeadsCount = Number(staleLeadsCountRows[0]?.count ?? 0);
    const activeDealsCount = Number(activeDealsCountRows[0]?.count ?? 0);
    const yesterdayAgentRuns = yesterdayRuns.reduce(
      (acc, r) => acc + Number(r.count),
      0,
    );
    const yesterdayCompletedAgentRuns =
      Number(
        yesterdayRuns.find((r) => r.status === 'completed')?.count ?? 0,
      );

    // Author the greeting + focus via Sonnet.
    const snapshot = {
      generatedAt: asOf.toISOString(),
      pendingApprovalsCount,
      unacknowledgedSignalsCount,
      staleLeadsCount,
      activeDealsCount,
      topApprovals: topApprovals.slice(0, 5).map((a) => ({
        actionType: a.actionType,
        rationale:
          typeof a.proposedPayload?.['rationale'] === 'string'
            ? (a.proposedPayload['rationale'] as string).slice(0, 200)
            : null,
      })),
      topSignals: topSignals.slice(0, 5).map((s) => ({
        severity: s.severity,
        title: s.title,
      })),
      riskyDeals: riskyDeals.map((d) => ({
        dealRef: d.dealRef,
        status: d.status,
        complianceHold: d.complianceHold,
      })),
    };

    const client = getClient();
    const response = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Snapshot (UTC ${asOf.toISOString()}):\n\n${JSON.stringify(snapshot, null, 2)}`,
        },
      ],
    });

    const costCents = costUsdCentsForTurn(MODELS.haiku, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });
    const costUsd = costCents / 100;
    const totalTokens =
      response.usage.input_tokens +
      response.usage.output_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    await ctx.costLedger.record({
      idempotencyKey: `daily_brief:${ctx.agentRunId}:${response.id}`,
      agentRunId: ctx.agentRunId,
      operation: 'llm.completion',
      provider: 'anthropic',
      model: MODELS.haiku,
      units: totalTokens,
      unitKind: 'tokens',
      costUsdMicros: costCents * 10_000,
      occurredAt: ctx.now(),
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');
    let parsed: { greeting?: string; recommendedFocus?: string };
    try {
      parsed = JSON.parse(
        text.trim().replace(/^```(?:json)?/, '').replace(/```$/, ''),
      );
    } catch {
      parsed = {};
    }
    const greeting = parsed.greeting ?? 'Good morning.';
    const recommendedFocus =
      parsed.recommendedFocus ??
      `${pendingApprovalsCount} pending approval${pendingApprovalsCount === 1 ? '' : 's'} waiting; ${unacknowledgedSignalsCount} unack signal${unacknowledgedSignalsCount === 1 ? '' : 's'}.`;

    const brief: DailyBrief = {
      generatedAt: asOf.toISOString(),
      greeting,
      recommendedFocus,
      pendingApprovalsCount,
      unacknowledgedSignalsCount,
      staleLeadsCount,
      activeDealsCount,
      topApprovals: topApprovals.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        createdAt: a.createdAt.toISOString(),
        rationale:
          typeof a.proposedPayload?.['rationale'] === 'string'
            ? (a.proposedPayload['rationale'] as string)
            : null,
      })),
      topSignals: topSignals.map((s) => ({
        id: s.id,
        severity: s.severity,
        title: s.title,
        createdAt: s.createdAt.toISOString(),
      })),
      riskyDeals: riskyDeals.map((d) => ({
        id: d.id,
        dealRef: d.dealRef,
        status: d.status,
        complianceHold: d.complianceHold,
      })),
      yesterdayAgentRuns,
      yesterdayCompletedAgentRuns,
    };

    // Write brief to summaries (subjectType='workspace', subjectId='global'
    // — single-user scope means there's exactly one workspace). Idempotent
    // on the per-version unique index — we always write version=1 today
    // and overwrite in place.
    const summaryId = createId();
    const today = new Date(asOf);
    today.setUTCHours(0, 0, 0, 0);
    await db
      .insert(summaries)
      .values({
        id: summaryId,
        subjectType: 'workspace',
        subjectId: 'global',
        summaryType: 'daily_brief',
        version: 1,
        content: JSON.stringify(brief),
        validityWindowStart: today,
        validityWindowEnd: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing({
        target: [
          summaries.subjectType,
          summaries.subjectId,
          summaries.summaryType,
          summaries.version,
        ],
      });
    // Always update content (overwrite latest)
    await db
      .update(summaries)
      .set({ content: JSON.stringify(brief), updatedAt: ctx.now() })
      .where(
        and(
          eq(summaries.subjectType, 'workspace'),
          eq(summaries.subjectId, 'global'),
          eq(summaries.summaryType, 'daily_brief'),
          eq(summaries.version, 1),
        ),
      );

    await db
      .insert(events)
      .values({
        id: createId(),
        verb: 'daily_brief.generated',
        subjectType: 'workspace',
        subjectId: 'global',
        actorType: 'system',
        actorId: this.name,
        objectType: 'summary',
        objectId: summaryId,
        occurredAt: ctx.now(),
        idempotencyKey: `daily_brief:${ctx.agentRunId}`,
        metadata: {
          pending_approvals: pendingApprovalsCount,
          unack_signals: unacknowledgedSignalsCount,
          stale_leads: staleLeadsCount,
          active_deals: activeDealsCount,
        },
      })
      .onConflictDoNothing({
        target: [events.occurredAt, events.idempotencyKey],
      });

    return {
      proposedActions: [],
      internalWrites: 1,
      costUsd,
      outputRefs: brief as unknown as Record<string, unknown>,
      rationale: `${pendingApprovalsCount} pending, ${unacknowledgedSignalsCount} signals, ${activeDealsCount} active deals`,
    };
  }
}
