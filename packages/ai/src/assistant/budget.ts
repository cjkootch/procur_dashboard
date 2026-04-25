import { db, aiUsage, companies } from '@procur/db';
import { and, eq, gte, sql } from 'drizzle-orm';

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

/**
 * Default monthly AI spend caps per plan, in USD cents.
 * null = unlimited. Tenants can override via
 * `companies.monthly_ai_budget_cents` (set by Procur staff in the
 * admin app); the override always wins when present.
 *
 * Starter numbers — revisit once we have real usage data.
 */
export const MONTHLY_BUDGET_CENTS: Record<PlanTier, number | null> = {
  free: 500, // $5
  pro: 2500, // $25
  team: 7500, // $75
  enterprise: null,
};

/** Resolve the effective cap for a tenant: per-row override > plan default. */
function effectiveBudgetCents(
  planTier: PlanTier,
  override: number | null | undefined,
): number | null {
  if (override != null) return override;
  return MONTHLY_BUDGET_CENTS[planTier];
}

export type UsageSource =
  | 'assistant'
  | 'enrich'
  | 'extract_requirements'
  | 'draft_section'
  | 'review_proposal'
  | 'map_requirements'
  | 'extract_pricing'
  | 'extract_company_profile'
  | 'shred_rfp'
  | 'suggest_requirements'
  | 'embeddings'
  | 'other';

export type BudgetStatus = {
  planTier: PlanTier;
  limitCents: number | null;
  usedCents: number;
  remainingCents: number | null;
  exceeded: boolean;
  monthStart: Date;
};

function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function getBudgetStatus(companyId: string): Promise<BudgetStatus> {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { planTier: true, monthlyAiBudgetCents: true },
  });
  const planTier = (company?.planTier ?? 'free') as PlanTier;
  const limitCents = effectiveBudgetCents(planTier, company?.monthlyAiBudgetCents);
  const ms = monthStart();

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${aiUsage.costUsdCents}), 0)::int` })
    .from(aiUsage)
    .where(
      and(eq(aiUsage.companyId, companyId), gte(aiUsage.date, ms.toISOString().slice(0, 10))),
    );

  const usedCents = row?.total ?? 0;
  const exceeded = limitCents !== null && usedCents >= limitCents;
  return {
    planTier,
    limitCents,
    usedCents,
    remainingCents: limitCents === null ? null : Math.max(0, limitCents - usedCents),
    exceeded,
    monthStart: ms,
  };
}

export type RecordUsageInput = {
  companyId: string;
  source: UsageSource;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsdCents: number;
};

/**
 * Upsert usage into the (company, date, source) daily bucket.
 * Safe to call from any AI task handler; failures are swallowed and logged
 * so a metering bug never prevents a user-facing task from completing.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db
      .insert(aiUsage)
      .values({
        companyId: input.companyId,
        date: today,
        source: input.source,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cacheCreationTokens: input.cacheCreationTokens ?? 0,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        costUsdCents: input.costUsdCents,
        calls: 1,
      })
      .onConflictDoUpdate({
        target: [aiUsage.companyId, aiUsage.date, aiUsage.source],
        set: {
          inputTokens: sql`${aiUsage.inputTokens} + ${input.inputTokens ?? 0}`,
          outputTokens: sql`${aiUsage.outputTokens} + ${input.outputTokens ?? 0}`,
          cacheCreationTokens: sql`${aiUsage.cacheCreationTokens} + ${input.cacheCreationTokens ?? 0}`,
          cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${input.cacheReadTokens ?? 0}`,
          costUsdCents: sql`${aiUsage.costUsdCents} + ${input.costUsdCents}`,
          calls: sql`${aiUsage.calls} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error('[ai-usage] recordUsage failed', err);
  }
}

export class BudgetExceededError extends Error {
  constructor(public status: BudgetStatus) {
    super(
      `AI budget exceeded for ${status.planTier} plan ($${(status.usedCents / 100).toFixed(2)} used of $${((status.limitCents ?? 0) / 100).toFixed(2)})`,
    );
    this.name = 'BudgetExceededError';
  }
}
