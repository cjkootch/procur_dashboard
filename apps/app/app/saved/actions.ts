'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db, savedOpportunities } from '@procur/db';
import { requireCompany } from '@procur/auth';

export async function unsaveOpportunityAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const savedId = String(formData.get('savedId') ?? '');
  if (!savedId) throw new Error('savedId required');

  await db
    .delete(savedOpportunities)
    .where(
      and(eq(savedOpportunities.id, savedId), eq(savedOpportunities.userId, user.id)),
    );

  revalidatePath('/saved');
}

export async function updateSavedNotesAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const savedId = String(formData.get('savedId') ?? '');
  const raw = String(formData.get('notes') ?? '').trim();
  if (!savedId) throw new Error('savedId required');

  await db
    .update(savedOpportunities)
    .set({ notes: raw.length > 0 ? raw : null })
    .where(
      and(eq(savedOpportunities.id, savedId), eq(savedOpportunities.userId, user.id)),
    );

  revalidatePath('/saved');
}
