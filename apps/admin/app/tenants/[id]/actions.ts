'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auditLog, companies, db } from '@procur/db';
import { requireAdmin } from '../../../lib/require-admin';

const PLAN_TIERS = ['free', 'pro', 'team', 'enterprise'] as const;
type PlanTier = (typeof PLAN_TIERS)[number];

export async function setTenantPlanTierAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const companyId = String(formData.get('companyId') ?? '');
  const planTier = String(formData.get('planTier') ?? '');
  if (!companyId || !PLAN_TIERS.includes(planTier as PlanTier)) {
    throw new Error('companyId + valid planTier required');
  }

  const before = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { planTier: true },
  });
  if (!before) throw new Error('tenant not found');
  if (before.planTier === planTier) return;

  await db
    .update(companies)
    .set({ planTier: planTier as PlanTier, updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  // Cross-tenant audit trail. The acting user is the admin (signed in
  // to the admin app), the entity is the tenant company.
  try {
    await db.insert(auditLog).values({
      companyId,
      userId: admin.id,
      action: 'admin.plan_tier_changed',
      entityType: 'company',
      entityId: companyId,
      changes: { before: { planTier: before.planTier }, after: { planTier } },
      metadata: { actorEmail: admin.email },
    });
  } catch (err) {
    console.error('[admin] audit insert failed', err);
  }

  revalidatePath(`/tenants/${companyId}`);
  revalidatePath('/tenants');
  revalidatePath('/');
}

/**
 * Set or clear the per-tenant monthly AI budget cap. Writes to
 * companies.monthly_ai_budget_cents (nullable). NULL means "use the
 * plan-tier default" — see MONTHLY_BUDGET_CENTS in @procur/ai.
 *
 * Form sends `budgetUsd` as a decimal dollar string. We store cents
 * server-side. An empty string clears the override (back to default).
 */
export async function setTenantBudgetAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) throw new Error('companyId required');

  const raw = String(formData.get('budgetUsd') ?? '').trim();
  let nextCents: number | null = null;
  if (raw.length > 0) {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('budgetUsd must be a non-negative number');
    }
    nextCents = Math.round(n * 100);
  }

  const before = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { monthlyAiBudgetCents: true },
  });
  if (!before) throw new Error('tenant not found');
  if ((before.monthlyAiBudgetCents ?? null) === nextCents) return;

  await db
    .update(companies)
    .set({ monthlyAiBudgetCents: nextCents, updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  try {
    await db.insert(auditLog).values({
      companyId,
      userId: admin.id,
      action: 'admin.ai_budget_changed',
      entityType: 'company',
      entityId: companyId,
      changes: {
        before: { monthlyAiBudgetCents: before.monthlyAiBudgetCents },
        after: { monthlyAiBudgetCents: nextCents },
      },
      metadata: { actorEmail: admin.email },
    });
  } catch (err) {
    console.error('[admin] audit insert failed', err);
  }

  revalidatePath(`/tenants/${companyId}`);
  revalidatePath('/tenants');
}
