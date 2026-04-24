'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { alertProfiles, db, type NewAlertProfile } from '@procur/db';
import { requireCompany } from '@procur/auth';

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function arr(formData: FormData, key: string): string[] | null {
  const all = formData.getAll(key).map((v) => String(v).trim()).filter(Boolean);
  if (all.length > 1) return all;
  const single = str(formData, key);
  if (!single) return null;
  const parts = single.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function num(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n.toString() : null;
}

function freq(formData: FormData): 'instant' | 'daily' | 'weekly' {
  const v = str(formData, 'frequency');
  if (v === 'instant' || v === 'weekly') return v;
  return 'daily';
}

async function requireOwned(userId: string, id: string) {
  const row = await db.query.alertProfiles.findFirst({
    where: and(eq(alertProfiles.id, id), eq(alertProfiles.userId, userId)),
  });
  if (!row) throw new Error('alert profile not found');
  return row;
}

export async function createAlertAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const name = str(formData, 'name');
  if (!name) throw new Error('name is required');

  const values: NewAlertProfile = {
    userId: user.id,
    companyId: company.id,
    name,
    jurisdictions: arr(formData, 'jurisdictions'),
    categories: arr(formData, 'categories'),
    keywords: arr(formData, 'keywords'),
    excludeKeywords: arr(formData, 'excludeKeywords'),
    minValue: num(formData, 'minValue'),
    maxValue: num(formData, 'maxValue'),
    frequency: freq(formData),
    emailEnabled: formData.get('emailEnabled') === 'on',
    active: true,
  };

  const [inserted] = await db
    .insert(alertProfiles)
    .values(values)
    .returning({ id: alertProfiles.id });
  revalidatePath('/alerts');
  if (inserted) redirect(`/alerts/${inserted.id}`);
}

export async function updateAlertAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwned(user.id, id);

  await db
    .update(alertProfiles)
    .set({
      name: str(formData, 'name') ?? 'Untitled alert',
      jurisdictions: arr(formData, 'jurisdictions'),
      categories: arr(formData, 'categories'),
      keywords: arr(formData, 'keywords'),
      excludeKeywords: arr(formData, 'excludeKeywords'),
      minValue: num(formData, 'minValue'),
      maxValue: num(formData, 'maxValue'),
      frequency: freq(formData),
      emailEnabled: formData.get('emailEnabled') === 'on',
      updatedAt: new Date(),
    })
    .where(eq(alertProfiles.id, id));

  revalidatePath(`/alerts/${id}`);
  revalidatePath('/alerts');
}

export async function toggleAlertActiveAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  const existing = await requireOwned(user.id, id);

  await db
    .update(alertProfiles)
    .set({ active: !existing.active, updatedAt: new Date() })
    .where(eq(alertProfiles.id, id));
  revalidatePath('/alerts');
  revalidatePath(`/alerts/${id}`);
}

export async function deleteAlertAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwned(user.id, id);

  await db.delete(alertProfiles).where(eq(alertProfiles.id, id));
  revalidatePath('/alerts');
  redirect('/alerts');
}
