'use server';

import { and, eq, inArray, like } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  contentLibrary,
  contracts,
  db,
  opportunities,
  pastPerformance,
  pricingModels,
  proposals,
  pursuits,
  pursuitTasks,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { seedSampleDataForCompany } from '../../lib/sample-data';

/**
 * Self-serve sample-data seed for new tenants. Called from the
 * SetupChecklist when the user wants to explore Procur without
 * waiting for real opportunities to appear in Discover.
 *
 * No-ops idempotently when the company already has any pursuits.
 */
export async function seedSampleDataAction(): Promise<void> {
  const { user, company } = await requireCompany();
  await seedSampleDataForCompany(company, user.id);
  revalidatePath('/');
  revalidatePath('/capture');
  revalidatePath('/capture/pursuits');
  redirect('/capture/pursuits');
}

/**
 * Inverse of seedSampleDataAction: remove every row that the seed
 * inserted, so a tenant can clear the demo content once they have
 * real data.
 *
 * Identification strategy: every sample row was inserted with a
 * recognizable marker:
 *   - opportunities: sourceReferenceId starts with `sample-{companyId}-`
 *   - contracts:     awardTitle starts with `[Sample]` (company-scoped)
 *   - library:       awardTitle starts with `[Sample]` (company-scoped)
 *   - past_perf:     projectName starts with `[Sample]` (company-scoped)
 * Pursuits are identified transitively (their opportunity is a sample).
 *
 * Children are deleted explicitly because a few of the FKs default to
 * RESTRICT (proposals, pricing_models, pursuit_tasks). Wrapped in a
 * transaction so a failure on any step rolls back the whole clear.
 *
 * If the user has built on top of the sample rows (added their own
 * proposals, pricing models, etc.) we still wipe them — the rows are
 * labeled `[Sample]` and the user explicitly asked to clear. That's
 * the documented contract.
 */
export async function clearSampleDataAction(): Promise<void> {
  const { company } = await requireCompany();

  await db.transaction(async (tx) => {
    // Sample opportunities for this tenant.
    const sampleOppRows = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(like(opportunities.sourceReferenceId, `sample-${company.id}-%`));
    const sampleOppIds = sampleOppRows.map((r) => r.id);

    // Sample pursuits = pursuits owned by this company linked to a sample opp.
    let samplePursuitIds: string[] = [];
    if (sampleOppIds.length > 0) {
      const samplePursuitRows = await tx
        .select({ id: pursuits.id })
        .from(pursuits)
        .where(
          and(
            eq(pursuits.companyId, company.id),
            inArray(pursuits.opportunityId, sampleOppIds),
          ),
        );
      samplePursuitIds = samplePursuitRows.map((r) => r.id);
    }

    if (samplePursuitIds.length > 0) {
      // RESTRICT FKs to pursuit — clear children first.
      await tx.delete(proposals).where(inArray(proposals.pursuitId, samplePursuitIds));
      await tx
        .delete(pricingModels)
        .where(inArray(pricingModels.pursuitId, samplePursuitIds));
      await tx
        .delete(pursuitTasks)
        .where(inArray(pursuitTasks.pursuitId, samplePursuitIds));

      // Pursuit cascades capabilities, gate-reviews, team-members.
      await tx
        .delete(pursuits)
        .where(
          and(eq(pursuits.companyId, company.id), inArray(pursuits.id, samplePursuitIds)),
        );
    }

    if (sampleOppIds.length > 0) {
      await tx.delete(opportunities).where(inArray(opportunities.id, sampleOppIds));
    }

    // Sample contract is standalone (no pursuit linkage). Cascades CLINs,
    // obligations, modifications, task areas.
    await tx
      .delete(contracts)
      .where(
        and(
          eq(contracts.companyId, company.id),
          like(contracts.awardTitle, '[Sample]%'),
        ),
      );

    // Sample library + past performance.
    await tx
      .delete(contentLibrary)
      .where(
        and(
          eq(contentLibrary.companyId, company.id),
          like(contentLibrary.title, '[Sample]%'),
        ),
      );

    await tx
      .delete(pastPerformance)
      .where(
        and(
          eq(pastPerformance.companyId, company.id),
          like(pastPerformance.projectName, '[Sample]%'),
        ),
      );
  });

  revalidatePath('/');
  revalidatePath('/capture');
  revalidatePath('/capture/pursuits');
  revalidatePath('/capture/pipeline');
  revalidatePath('/contract');
  revalidatePath('/library');
  revalidatePath('/past-performance');
  revalidatePath('/settings');
}
