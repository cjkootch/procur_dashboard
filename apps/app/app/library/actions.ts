'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { contentLibrary, db, type NewContentLibraryEntry } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { chunkContent, embedMany, embedText, meter, meterEmbedding, MODELS } from '@procur/ai';
import { LIBRARY_TYPES, type LibraryType } from '../../lib/library-queries';
import { extractTextFromFile } from '../../lib/extract-text';

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

export async function ingestFileAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new Error('upload a file');
  }
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('file too large (max 15 MB)');
  }

  const { text, pageCount } = await extractTextFromFile(file);
  const trimmed = text.trim();
  if (trimmed.length < 100) {
    throw new Error('extracted text is too short to be useful');
  }

  // Haiku chunks the full doc into library entries. Falls back to a single
  // entry if the chunker fails (e.g. no ANTHROPIC_API_KEY in the current env).
  let chunks: Array<{ title: string; type: LibraryType; content: string; tags: string[] }>;
  try {
    const result = await chunkContent({ sourceName: file.name, text: trimmed });
    await meter({
      companyId: company.id,
      source: 'other',
      model: MODELS.haiku,
      usage: result.usage,
    });
    chunks = result.chunks.map((c) => ({
      title: c.title,
      type: c.type as LibraryType,
      content: c.content,
      tags: c.tags,
    }));
  } catch (err) {
    console.warn('chunker failed, ingesting as single entry', err);
    chunks = [
      {
        title: file.name.replace(/\.[^.]+$/, ''),
        type: 'boilerplate' as LibraryType,
        content: trimmed.slice(0, 50_000),
        tags: pageCount ? [`pages-${pageCount}`] : [],
      },
    ];
  }

  // Batch-embed all chunks at once (one OpenAI call)
  let embeddings: (number[] | null)[] = chunks.map(() => null);
  if (process.env.OPENAI_API_KEY) {
    try {
      const inputs = chunks.map((c) => `${c.title}\n\n${c.content}`);
      const vectors = await embedMany(inputs);
      embeddings = vectors;
      const totalChars = inputs.reduce((s, t) => s + t.length, 0);
      await meterEmbedding({
        companyId: company.id,
        tokens: Math.ceil(totalChars / 4),
      });
    } catch (err) {
      console.warn('embedding failed, chunks saved without index', err);
    }
  }

  const rows: NewContentLibraryEntry[] = chunks.map((c, i) => ({
    companyId: company.id,
    type: c.type,
    title: c.title,
    content: c.content,
    tags: c.tags.length > 0 ? c.tags : null,
    embedding: embeddings[i] ?? null,
    metadata: { sourceFile: file.name, pageCount },
  }));

  await db.insert(contentLibrary).values(rows);

  revalidatePath('/library');
  redirect(`/library?ingested=${chunks.length}`);
}
