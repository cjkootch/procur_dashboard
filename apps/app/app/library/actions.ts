'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { contentLibrary, db, type NewContentLibraryEntry } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { embedText } from '@procur/ai';
import { LIBRARY_TYPES, type LibraryType } from '../../lib/library-queries';

function isLibraryType(v: string): v is LibraryType {
  return (LIBRARY_TYPES as readonly string[]).includes(v);
}

async function safeEmbed(text: string): Promise<number[] | null> {
  try {
    if (!process.env.OPENAI_API_KEY) return null;
    return await embedText(text);
  } catch (err) {
    console.error('embed failed', err);
    return null;
  }
}

export async function createLibraryEntryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const title = String(formData.get('title') ?? '').trim();
  const type = String(formData.get('type') ?? '');
  const content = String(formData.get('content') ?? '').trim();
  const tagsRaw = String(formData.get('tags') ?? '');

  if (!title) throw new Error('title required');
  if (!isLibraryType(type)) throw new Error(`invalid type "${type}"`);
  if (!content) throw new Error('content required');

  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const embedding = await safeEmbed(`${title}\n\n${content}`);

  const row: NewContentLibraryEntry = {
    companyId: company.id,
    type,
    title,
    content,
    tags: tags.length > 0 ? tags : null,
    embedding: embedding ?? null,
  };
  const [created] = await db.insert(contentLibrary).values(row).returning({ id: contentLibrary.id });
  if (!created) throw new Error('insert failed');

  revalidatePath('/library');
  redirect(`/library/${created.id}`);
}

export async function updateLibraryEntryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  const title = String(formData.get('title') ?? '').trim();
  const type = String(formData.get('type') ?? '');
  const content = String(formData.get('content') ?? '').trim();
  const tagsRaw = String(formData.get('tags') ?? '');

  const existing = await db.query.contentLibrary.findFirst({
    where: and(eq(contentLibrary.id, id), eq(contentLibrary.companyId, company.id)),
  });
  if (!existing) throw new Error('not found');

  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Re-embed if title or content changed
  const changedText =
    title !== existing.title || content !== existing.content;
  const embedding = changedText ? await safeEmbed(`${title}\n\n${content}`) : undefined;

  await db
    .update(contentLibrary)
    .set({
      title,
      type: isLibraryType(type) ? type : existing.type,
      content,
      tags: tags.length > 0 ? tags : null,
      ...(embedding !== undefined ? { embedding: embedding ?? null } : {}),
      version: sql`${contentLibrary.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(contentLibrary.id, id));

  revalidatePath('/library');
  revalidatePath(`/library/${id}`);
}

export async function deleteLibraryEntryAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('id required');
  await db
    .delete(contentLibrary)
    .where(and(eq(contentLibrary.id, id), eq(contentLibrary.companyId, company.id)));
  revalidatePath('/library');
  redirect('/library');
}
