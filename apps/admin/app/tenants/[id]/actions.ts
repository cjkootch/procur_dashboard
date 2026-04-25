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
