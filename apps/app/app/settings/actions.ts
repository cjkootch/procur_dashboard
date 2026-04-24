'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { companies, db } from '@procur/db';
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

function int(formData: FormData, key: string): number | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export async function updateCompanyProfileAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();

  await db
    .update(companies)
    .set({
      name: str(formData, 'name') ?? company.name,
      websiteUrl: str(formData, 'websiteUrl'),
      country: str(formData, 'country'),
      industry: str(formData, 'industry'),
      yearFounded: int(formData, 'yearFounded'),
      employeeCount: int(formData, 'employeeCount'),
      annualRevenue: str(formData, 'annualRevenue'),
      capabilities: arr(formData, 'capabilities'),
      preferredJurisdictions: arr(formData, 'preferredJurisdictions'),
      preferredCategories: arr(formData, 'preferredCategories'),
      targetContractSizeMin: int(formData, 'targetContractSizeMin'),
      targetContractSizeMax: int(formData, 'targetContractSizeMax'),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, company.id));

  revalidatePath('/settings');
}
