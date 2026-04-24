import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { contentLibrary, db, type ContentLibraryEntry } from '@procur/db';

export const LIBRARY_TYPES = [
  'capability_statement',
  'team_bio',
  'past_performance',
  'boilerplate',
  'certification',
  'executive_summary',
  'technical_approach',
  'management_plan',
] as const;

export type LibraryType = (typeof LIBRARY_TYPES)[number];

export const LIBRARY_TYPE_LABEL: Record<LibraryType, string> = {
  capability_statement: 'Capability statement',
  team_bio: 'Team bio',
  past_performance: 'Past performance',
  boilerplate: 'Boilerplate',
  certification: 'Certification',
  executive_summary: 'Executive summary template',
  technical_approach: 'Technical approach template',
  management_plan: 'Management plan template',
};

export async function listLibrary(companyId: string): Promise<ContentLibraryEntry[]> {
  return db
    .select()
    .from(contentLibrary)
    .where(eq(contentLibrary.companyId, companyId))
    .orderBy(desc(contentLibrary.updatedAt));
}

export async function getLibraryEntry(
  companyId: string,
  id: string,
): Promise<ContentLibraryEntry | null> {
  const row = await db.query.contentLibrary.findFirst({
    where: and(eq(contentLibrary.id, id), eq(contentLibrary.companyId, companyId)),
  });
  return row ?? null;
}

/**
 * Semantic search: cosine distance between the query embedding and each library
 * entry's embedding, filtered to the same company. Returns top-k.
 *
 * pgvector's `<=>` operator is cosine distance (lower is closer).
 */
export async function semanticSearchLibrary(
  companyId: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<Array<Pick<ContentLibraryEntry, 'id' | 'title' | 'type' | 'content'>>> {
  // Stringify the vector as pgvector expects: '[0.1,0.2,...]'
  const literal = `[${queryEmbedding.join(',')}]`;
  return db
    .select({
      id: contentLibrary.id,
      title: contentLibrary.title,
      type: contentLibrary.type,
      content: contentLibrary.content,
    })
    .from(contentLibrary)
    .where(
      and(
        eq(contentLibrary.companyId, companyId),
        sql`${contentLibrary.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${contentLibrary.embedding} <=> ${literal}::vector`)
    .limit(limit);
}
