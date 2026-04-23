import { and, eq } from 'drizzle-orm';
import { db, documents, opportunities, taxonomyCategories } from '@procur/db';

export async function loadOpportunity(opportunityId: string) {
  const row = await db.query.opportunities.findFirst({
    where: eq(opportunities.id, opportunityId),
  });
  return row ?? null;
}

export async function loadAgencyName(agencyId: string | null): Promise<string | undefined> {
  if (!agencyId) return undefined;
  const row = await db.query.agencies.findFirst({
    where: (a, { eq: eqFn }) => eqFn(a.id, agencyId),
    columns: { name: true },
  });
  return row?.name;
}

/**
 * Load best-available document text for an opportunity.
 * Prefers processed extractedText; falls back to any that exist.
 * Returns undefined if no documents are attached.
 */
export async function loadDocumentText(opportunityId: string): Promise<string | undefined> {
  const docs = await db.query.documents.findMany({
    where: and(
      eq(documents.opportunityId, opportunityId),
      eq(documents.processingStatus, 'completed'),
    ),
    columns: { extractedText: true },
  });
  const combined = docs
    .map((d) => d.extractedText)
    .filter((t): t is string => !!t && t.length > 0)
    .join('\n\n');
  return combined.length > 0 ? combined : undefined;
}

export async function loadTaxonomy() {
  return db
    .select({
      slug: taxonomyCategories.slug,
      name: taxonomyCategories.name,
      parentSlug: taxonomyCategories.parentSlug,
    })
    .from(taxonomyCategories)
    .where(eq(taxonomyCategories.active, true));
}
