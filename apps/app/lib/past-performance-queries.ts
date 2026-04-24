import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  contracts,
  db,
  pastPerformance,
  type PastPerformance,
} from '@procur/db';
import { embedText } from '@procur/ai';

export type PastPerformanceMatch = {
  id: string;
  projectName: string;
  customerName: string;
  scopeDescription: string;
  keyAccomplishments: string[] | null;
  outcomes: string | null;
};

/**
 * Top-k past performance entries for the given query embedding. Uses pgvector
 * cosine distance (`<=>`, lower is closer). Filtered to the same company and
 * only rows with an embedding populated.
 */
export async function semanticSearchPastPerformance(
  companyId: string,
  queryEmbedding: number[],
  limit = 3,
): Promise<PastPerformanceMatch[]> {
  const literal = `[${queryEmbedding.join(',')}]`;
  return db
    .select({
      id: pastPerformance.id,
      projectName: pastPerformance.projectName,
      customerName: pastPerformance.customerName,
      scopeDescription: pastPerformance.scopeDescription,
      keyAccomplishments: pastPerformance.keyAccomplishments,
      outcomes: pastPerformance.outcomes,
    })
    .from(pastPerformance)
    .where(
      and(
        eq(pastPerformance.companyId, companyId),
        sql`${pastPerformance.embedding} IS NOT NULL`,
      ),
    )
    .orderBy(sql`${pastPerformance.embedding} <=> ${literal}::vector`)
    .limit(limit);
}

/**
 * Graceful wrapper: embeds the query text via OpenAI and runs semantic search.
 * Returns `null` if embeddings aren't configured, an empty array if nothing
 * matches.
 */
export async function getRelevantPastPerformance(
  companyId: string,
  queryText: string,
  limit = 3,
): Promise<PastPerformanceMatch[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const emb = await embedText(queryText);
    return await semanticSearchPastPerformance(companyId, emb, limit);
  } catch (err) {
    console.warn('past-performance retrieval skipped:', err);
    return null;
  }
}

export type PastPerformanceListRow = {
  id: string;
  projectName: string;
  customerName: string;
  customerType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalValue: string | null;
  currency: string | null;
  categoryCount: number;
  updatedAt: Date;
};

export async function listPastPerformance(
  companyId: string,
): Promise<PastPerformanceListRow[]> {
  const rows = await db
    .select()
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, companyId))
    .orderBy(desc(pastPerformance.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    projectName: r.projectName,
    customerName: r.customerName,
    customerType: r.customerType,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    totalValue: r.totalValue,
    currency: r.currency,
    categoryCount: (r.categories ?? []).length,
    updatedAt: r.updatedAt,
  }));
}

export async function getPastPerformanceById(
  companyId: string,
  id: string,
): Promise<PastPerformance | null> {
  const row = await db.query.pastPerformance.findFirst({
    where: and(eq(pastPerformance.id, id), eq(pastPerformance.companyId, companyId)),
  });
  return row ?? null;
}

export type ConvertibleContract = {
  id: string;
  awardTitle: string;
  awardingAgency: string | null;
  startDate: string | null;
  endDate: string | null;
  totalValue: string | null;
  currency: string | null;
  status: string;
  hasPastPerformance: boolean;
};

/**
 * Completed or still-active contracts we could convert into a past
 * performance record. Flags any that already have one (matched by
 * project name for now — the schema lacks a direct FK).
 */
export async function listConvertibleContracts(companyId: string): Promise<ConvertibleContract[]> {
  const [cs, pps] = await Promise.all([
    db
      .select({
        id: contracts.id,
        awardTitle: contracts.awardTitle,
        awardingAgency: contracts.awardingAgency,
        startDate: contracts.startDate,
        endDate: contracts.endDate,
        totalValue: contracts.totalValue,
        currency: contracts.currency,
        status: contracts.status,
      })
      .from(contracts)
      .where(eq(contracts.companyId, companyId))
      .orderBy(desc(contracts.updatedAt)),
    db
      .select({ projectName: pastPerformance.projectName })
      .from(pastPerformance)
      .where(eq(pastPerformance.companyId, companyId)),
  ]);

  const existingNames = new Set(pps.map((p) => p.projectName.toLowerCase()));
  return cs.map((c) => ({
    ...c,
    hasPastPerformance: existingNames.has(c.awardTitle.toLowerCase()),
  }));
}
