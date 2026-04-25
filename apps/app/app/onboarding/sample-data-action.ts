'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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
