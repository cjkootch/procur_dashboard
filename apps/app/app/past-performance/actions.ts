'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { contracts, db, pastPerformance, type NewPastPerformance } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { embedText } from '@procur/ai';

async function safeEmbed(text: string): Promise<number[] | null> {
  try {
    if (!process.env.OPENAI_API_KEY) return null;
    return await embedText(text);
  } catch (err) {
    console.error('past-performance embed failed', err);
    return null;
  }
}

function buildEmbeddingText(fields: {
  projectName: string;
  customerName: string;
  scopeDescription: string;
  keyAccomplishments?: string[] | null;
  outcomes?: string | null;
  categories?: string[] | null;
  keywords?: string[] | null;
}): string {
  return [
    fields.projectName,
    `Customer: ${fields.customerName}`,
    `Scope: ${fields.scopeDescription}`,
    fields.outcomes ? `Outcomes: ${fields.outcomes}` : '',
    (fields.keyAccomplishments ?? []).length > 0
      ? `Accomplishments: ${(fields.keyAccomplishments ?? []).join(' | ')}`
      : '',
    (fields.categories ?? []).length > 0
      ? `Categories: ${(fields.categories ?? []).join(', ')}`
      : '',
    (fields.keywords ?? []).length > 0
      ? `Keywords: ${(fields.keywords ?? []).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function arr(formData: FormData, key: string): string[] | null {
  const v = str(formData, key);
  if (!v) return null;
  const parts = v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function num(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

async function requireOwned(companyId: string, id: string) {
  const row = await db.query.pastPerformance.findFirst({
    where: and(eq(pastPerformance.id, id), eq(pastPerformance.companyId, companyId)),
  });
  if (!row) throw new Error('past performance not found');
  return row;
}

export async function createPastPerformanceAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const projectName = str(formData, 'projectName');
  const customerName = str(formData, 'customerName');
  const scopeDescription = str(formData, 'scopeDescription');
  if (!projectName || !customerName || !scopeDescription) {
    throw new Error('projectName, customerName, and scopeDescription required');
  }

  const keyAccomplishments = arr(formData, 'keyAccomplishments');
  const outcomes = str(formData, 'outcomes');
  const categories = arr(formData, 'categories');
  const keywords = arr(formData, 'keywords');

  const embedding = await safeEmbed(
    buildEmbeddingText({
      projectName,
      customerName,
      scopeDescription,
      keyAccomplishments,
      outcomes,
      categories,
      keywords,
    }),
  );

  const values: NewPastPerformance = {
    companyId: company.id,
    projectName,
    customerName,
    customerType: str(formData, 'customerType'),
    periodStart: str(formData, 'periodStart'),
    periodEnd: str(formData, 'periodEnd'),
    totalValue: num(formData, 'totalValue'),
    currency: str(formData, 'currency')?.slice(0, 3).toUpperCase() ?? 'USD',
    scopeDescription,
    keyAccomplishments,
    challenges: str(formData, 'challenges'),
    outcomes,
    referenceName: str(formData, 'referenceName'),
    referenceTitle: str(formData, 'referenceTitle'),
    referenceEmail: str(formData, 'referenceEmail'),
    referencePhone: str(formData, 'referencePhone'),
    naicsCodes: arr(formData, 'naicsCodes'),
    categories,
    keywords,
    embedding,
  };

  const [inserted] = await db
    .insert(pastPerformance)
    .values(values)
    .returning({ id: pastPerformance.id });
  revalidatePath('/past-performance');
  if (inserted) redirect(`/past-performance/${inserted.id}`);
}

export async function updatePastPerformanceAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwned(company.id, id);

  const projectName = str(formData, 'projectName') ?? 'Untitled';
  const customerName = str(formData, 'customerName') ?? 'Unknown customer';
  const scopeDescription = str(formData, 'scopeDescription') ?? '';
  const keyAccomplishments = arr(formData, 'keyAccomplishments');
  const outcomes = str(formData, 'outcomes');
  const categories = arr(formData, 'categories');
  const keywords = arr(formData, 'keywords');

  const embedding = await safeEmbed(
    buildEmbeddingText({
      projectName,
      customerName,
      scopeDescription,
      keyAccomplishments,
      outcomes,
      categories,
      keywords,
    }),
  );

  await db
    .update(pastPerformance)
    .set({
      projectName,
      customerName,
      customerType: str(formData, 'customerType'),
      periodStart: str(formData, 'periodStart'),
      periodEnd: str(formData, 'periodEnd'),
      totalValue: num(formData, 'totalValue'),
      currency: str(formData, 'currency')?.slice(0, 3).toUpperCase() ?? 'USD',
      scopeDescription,
      keyAccomplishments,
      challenges: str(formData, 'challenges'),
      outcomes,
      referenceName: str(formData, 'referenceName'),
      referenceTitle: str(formData, 'referenceTitle'),
      referenceEmail: str(formData, 'referenceEmail'),
      referencePhone: str(formData, 'referencePhone'),
      naicsCodes: arr(formData, 'naicsCodes'),
      categories,
      keywords,
      ...(embedding !== null ? { embedding } : {}),
      updatedAt: new Date(),
    })
    .where(eq(pastPerformance.id, id));

  revalidatePath(`/past-performance/${id}`);
  revalidatePath('/past-performance');
}

export async function deletePastPerformanceAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = str(formData, 'id');
  if (!id) throw new Error('id required');
  await requireOwned(company.id, id);

  await db.delete(pastPerformance).where(eq(pastPerformance.id, id));
  revalidatePath('/past-performance');
  redirect('/past-performance');
}

export async function generateFromContractAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const contractId = str(formData, 'contractId');
  if (!contractId) throw new Error('contractId required');

  const contract = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, contractId), eq(contracts.companyId, company.id)),
  });
  if (!contract) throw new Error('contract not found');

  // Avoid duplicates: match by exact projectName.
  const existing = await db.query.pastPerformance.findFirst({
    where: and(
      eq(pastPerformance.companyId, company.id),
      eq(pastPerformance.projectName, contract.awardTitle),
    ),
  });
  if (existing) redirect(`/past-performance/${existing.id}`);

  const obligations = contract.obligations ?? [];
  const completedObligations = obligations.filter((o) => o.status === 'completed');
  const accomplishments =
    completedObligations.length > 0
      ? completedObligations.map((o) => o.description)
      : null;

  const projectName = contract.awardTitle;
  const customerName = contract.awardingAgency ?? 'Unknown customer';
  const scopeDescription = contract.notes ?? contract.awardTitle;

  const embedding = await safeEmbed(
    buildEmbeddingText({
      projectName,
      customerName,
      scopeDescription,
      keyAccomplishments: accomplishments,
    }),
  );

  const [inserted] = await db
    .insert(pastPerformance)
    .values({
      companyId: company.id,
      projectName,
      customerName,
      customerType: contract.awardingAgency ? 'government' : null,
      periodStart: contract.startDate,
      periodEnd: contract.endDate,
      totalValue: contract.totalValue,
      currency: contract.currency ?? 'USD',
      scopeDescription,
      keyAccomplishments: accomplishments,
      embedding,
    })
    .returning({ id: pastPerformance.id });

  revalidatePath('/past-performance');
  revalidatePath(`/contract/${contractId}`);
  if (inserted) redirect(`/past-performance/${inserted.id}`);
}
