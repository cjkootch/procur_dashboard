import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  marketAtlasFacts,
  type MarketAtlasFact,
  type NewMarketAtlasFact,
} from '@procur/db';
import { createId } from '@procur/ai';

/**
 * Read/write helpers for the market atlas — cross-probe memory of
 * market structure (gatekeepers, dead ends, referrals, signal
 * quality, compliance quirks).
 *
 * Discipline:
 *   - Append-only via `superseded_by`. To "edit" a fact, write a new
 *     one and point the old one's superseded_by at it. Listing
 *     defaults to current (non-superseded) facts only.
 *   - Authored by 'operator' or 'agent'. Confidence defaults differ
 *     (operator 0.9, agent 0.5) so the UI can render strength.
 */

export const ATLAS_FACT_TYPES = [
  'gatekeeper',
  'bottleneck',
  'dead_end',
  'referral',
  'relationship',
  'signal_mattered',
  'signal_noise',
  'assumption_wrong',
  'procurement_pattern',
  'compliance_note',
] as const;
export type AtlasFactType = (typeof ATLAS_FACT_TYPES)[number];

export interface AddAtlasFactInput {
  country: string;
  segment?: string | null;
  entitySlug?: string | null;
  relatedEntitySlug?: string | null;
  factType: AtlasFactType | string;
  description: string;
  sourceProbeId?: string | null;
  sourceTargetId?: string | null;
  sourceEventId?: string | null;
  authoredBy?: 'operator' | 'agent';
  confidence?: number;
  createdByUserId?: string | null;
}

export async function addAtlasFact(
  input: AddAtlasFactInput,
): Promise<MarketAtlasFact> {
  const authoredBy = input.authoredBy ?? 'operator';
  const row: NewMarketAtlasFact = {
    id: createId(),
    country: input.country.toUpperCase(),
    segment: input.segment ?? null,
    entitySlug: input.entitySlug ?? null,
    relatedEntitySlug: input.relatedEntitySlug ?? null,
    factType: input.factType,
    description: input.description,
    sourceProbeId: input.sourceProbeId ?? null,
    sourceTargetId: input.sourceTargetId ?? null,
    sourceEventId: input.sourceEventId ?? null,
    authoredBy,
    // Operator facts are typically high-confidence; agent facts start
    // lower and rise as repeated probes corroborate.
    confidence: String(
      input.confidence ?? (authoredBy === 'operator' ? 0.9 : 0.5),
    ),
    createdByUserId: input.createdByUserId ?? null,
  };
  const [created] = await db.insert(marketAtlasFacts).values(row).returning();
  if (!created) throw new Error('addAtlasFact: insert returned no row');
  return created;
}

/**
 * Mark a fact superseded by a new one. Both must exist; the new fact
 * is left untouched (it's the surviving record).
 */
export async function supersedeAtlasFact(input: {
  oldFactId: string;
  newFactId: string;
}): Promise<void> {
  await db
    .update(marketAtlasFacts)
    .set({ supersededBy: input.newFactId, updatedAt: new Date() })
    .where(eq(marketAtlasFacts.id, input.oldFactId));
}

/**
 * Cross-probe atlas read for /market-atlas/[country]. Defaults to
 * current (non-superseded) facts only. Optional segment filter.
 */
export async function listAtlasFacts(input: {
  country: string;
  segment?: string;
  factType?: AtlasFactType | string;
  includeSuperseded?: boolean;
  limit?: number;
}): Promise<MarketAtlasFact[]> {
  const limit = input.limit ?? 200;
  const conditions = [
    eq(marketAtlasFacts.country, input.country.toUpperCase()),
  ];
  if (input.segment) {
    conditions.push(eq(marketAtlasFacts.segment, input.segment));
  }
  if (input.factType) {
    conditions.push(eq(marketAtlasFacts.factType, input.factType));
  }
  if (!input.includeSuperseded) {
    conditions.push(isNull(marketAtlasFacts.supersededBy));
  }
  return await db
    .select()
    .from(marketAtlasFacts)
    .where(and(...conditions))
    .orderBy(desc(marketAtlasFacts.createdAt))
    .limit(limit);
}

/**
 * Probe-scoped atlas read — facts surfaced by THIS probe (regardless
 * of country, since some probes span borders). Default sort: most
 * recent first. Used by the probe detail page's atlas panel.
 */
export async function listAtlasFactsForProbe(
  probeId: string,
): Promise<MarketAtlasFact[]> {
  return await db
    .select()
    .from(marketAtlasFacts)
    .where(
      and(
        eq(marketAtlasFacts.sourceProbeId, probeId),
        isNull(marketAtlasFacts.supersededBy),
      ),
    )
    .orderBy(desc(marketAtlasFacts.createdAt));
}

/**
 * List of countries with atlas coverage — feeds the index page
 * (`/market-atlas` shows countries with at least one fact, ordered
 * by recency). Returns counts per country so the index can render
 * "Barbados (12 facts) · last updated 2d ago".
 */
export async function listAtlasCountries(): Promise<
  Array<{
    country: string;
    factCount: number;
    lastUpdatedAt: Date;
  }>
> {
  const rows = await db
    .select({
      country: marketAtlasFacts.country,
      factCount: sql<number>`COUNT(*)::int`,
      lastUpdatedAt: sql<Date>`MAX(${marketAtlasFacts.updatedAt})`,
    })
    .from(marketAtlasFacts)
    .where(isNull(marketAtlasFacts.supersededBy))
    .groupBy(marketAtlasFacts.country)
    .orderBy(desc(sql`MAX(${marketAtlasFacts.updatedAt})`));
  return rows;
}
