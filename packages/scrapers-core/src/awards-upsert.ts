import { and, eq } from 'drizzle-orm';
import {
  db,
  awards,
  awardAwardees,
  externalSuppliers,
  supplierAliases,
} from '@procur/db';

export type UpsertAwardOutcome = 'inserted' | 'updated';

/**
 * Lowercase, strip common corporate suffixes, collapse whitespace.
 *
 * MUST stay in sync with `normalizeSupplierName` in
 * packages/catalog/src/queries.ts. The query layer normalizes user
 * input the same way before fuzzy-matching against this table, so any
 * drift here causes silent miss rates at query time.
 *
 * TODO: lift this into a shared location once we have a third caller.
 */
export function normalizeSupplierName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(s\.?\s?a\.?(\s?s)?|s\.?\s?r\.?\s?l\.?|llc|l\.?l\.?c\.?|inc|inc\.|incorporated|corp|corp\.|corporation|ltd|ltd\.|limited|gmbh|n\.?v\.?|b\.?v\.?|p\.?l\.?c\.?|plc|s\.?p\.?a\.?)\b/g,
      ' ',
    )
    .replace(/[.,&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type UpsertExternalSupplierInput = {
  jurisdictionId: string;
  sourcePortal: string;
  sourceReferenceId: string;
  organisationName: string;
  country?: string | null;
  rawData?: Record<string, unknown>;
};

/**
 * Upsert an external_suppliers row keyed by
 * (jurisdictionId, sourceName, sourceReferenceId). Returns the canonical
 * supplier UUID for use as an FK target by award_awardees.
 *
 * The same supplier appearing across multiple portals will produce
 * multiple rows here — alias merging across portals happens later in a
 * separate review workflow.
 */
export async function upsertExternalSupplier(
  input: UpsertExternalSupplierInput,
): Promise<string> {
  const inserted = await db
    .insert(externalSuppliers)
    .values({
      jurisdictionId: input.jurisdictionId,
      sourceName: input.sourcePortal,
      sourceReferenceId: input.sourceReferenceId,
      organisationName: input.organisationName,
      country: input.country ?? null,
      rawData: input.rawData,
    })
    .onConflictDoUpdate({
      target: [
        externalSuppliers.jurisdictionId,
        externalSuppliers.sourceName,
        externalSuppliers.sourceReferenceId,
      ],
      set: {
        organisationName: input.organisationName,
        lastSeenAt: new Date(),
      },
    })
    .returning({ id: externalSuppliers.id });

  const id = inserted[0]?.id;
  if (id) return id;

  // Fallback fetch — onConflictDoUpdate without RETURNING can race in
  // edge cases (it shouldn't here, but defensive).
  const refetched = await db.query.externalSuppliers.findFirst({
    where: and(
      eq(externalSuppliers.jurisdictionId, input.jurisdictionId),
      eq(externalSuppliers.sourceName, input.sourcePortal),
      eq(externalSuppliers.sourceReferenceId, input.sourceReferenceId),
    ),
    columns: { id: true },
  });
  if (!refetched) {
    throw new Error(
      `upsertExternalSupplier: failed to resolve supplier for ${input.sourcePortal}::${input.sourceReferenceId}`,
    );
  }
  return refetched.id;
}

export type UpsertSupplierAliasInput = {
  supplierId: string;
  alias: string;
  sourcePortal: string;
  /** 0..1; defaults to 1.0 since canonical-portal aliases are authoritative. */
  confidence?: number;
  /** True for direct portal aliases; false for fuzzy-matched candidates needing review. */
  verified?: boolean;
};

export async function upsertSupplierAlias(input: UpsertSupplierAliasInput): Promise<void> {
  const aliasNormalized = normalizeSupplierName(input.alias);
  if (!aliasNormalized) return; // empty after normalization — no value indexing it

  await db
    .insert(supplierAliases)
    .values({
      supplierId: input.supplierId,
      alias: input.alias,
      aliasNormalized,
      sourcePortal: input.sourcePortal,
      confidence: (input.confidence ?? 1.0).toFixed(2),
      verified: input.verified ?? true,
    })
    .onConflictDoNothing({
      target: [supplierAliases.supplierId, supplierAliases.aliasNormalized],
    });
}

export type UpsertAwardInput = {
  sourcePortal: string;
  sourceAwardId: string;
  jurisdictionId: string;
  buyerName: string;
  buyerCountry: string;
  beneficiaryCountry?: string | null;
  title?: string | null;
  commodityDescription?: string | null;
  unspscCodes?: string[];
  cpvCodes?: string[];
  categoryTags?: string[];
  contractValueNative?: number | null;
  contractCurrency?: string | null;
  contractValueUsd?: number | null;
  awardDate: string;
  status?: string;
  sourceUrl?: string | null;
  rawPayload?: Record<string, unknown>;
};

/**
 * Upsert an awards row keyed by (sourcePortal, sourceAwardId).
 * Returns the resolved award UUID + whether the row was newly inserted
 * vs updated, so the caller can track delta-counts in the run summary.
 */
export async function upsertAward(
  input: UpsertAwardInput,
): Promise<{ awardId: string; outcome: UpsertAwardOutcome }> {
  // Detect insert-vs-update by checking existence first. RETURNING
  // alone can't distinguish on conflict-do-update.
  const existing = await db.query.awards.findFirst({
    where: and(
      eq(awards.sourcePortal, input.sourcePortal),
      eq(awards.sourceAwardId, input.sourceAwardId),
    ),
    columns: { id: true },
  });

  const inserted = await db
    .insert(awards)
    .values({
      sourcePortal: input.sourcePortal,
      sourceAwardId: input.sourceAwardId,
      sourceUrl: input.sourceUrl ?? null,
      rawPayload: input.rawPayload,
      jurisdictionId: input.jurisdictionId,
      buyerName: input.buyerName,
      buyerCountry: input.buyerCountry,
      beneficiaryCountry: input.beneficiaryCountry ?? null,
      title: input.title ?? null,
      commodityDescription: input.commodityDescription ?? null,
      unspscCodes: input.unspscCodes,
      cpvCodes: input.cpvCodes,
      categoryTags: input.categoryTags,
      contractValueNative:
        input.contractValueNative != null ? String(input.contractValueNative) : null,
      contractCurrency: input.contractCurrency ?? null,
      contractValueUsd: input.contractValueUsd != null ? String(input.contractValueUsd) : null,
      awardDate: input.awardDate,
      status: input.status ?? 'active',
    })
    .onConflictDoUpdate({
      target: [awards.sourcePortal, awards.sourceAwardId],
      set: {
        rawPayload: input.rawPayload,
        title: input.title ?? null,
        commodityDescription: input.commodityDescription ?? null,
        contractValueNative:
          input.contractValueNative != null ? String(input.contractValueNative) : null,
        contractValueUsd:
          input.contractValueUsd != null ? String(input.contractValueUsd) : null,
        status: input.status ?? 'active',
        updatedAt: new Date(),
      },
    })
    .returning({ id: awards.id });

  const awardId = inserted[0]?.id;
  if (!awardId) {
    throw new Error(
      `upsertAward: insert returned no id for ${input.sourcePortal}::${input.sourceAwardId}`,
    );
  }

  return { awardId, outcome: existing ? 'updated' : 'inserted' };
}

export type LinkAwardAwardeeInput = {
  awardId: string;
  supplierId: string;
  role?: 'prime' | 'subcontractor' | 'consortium_member' | 'consortium_lead';
  sharePct?: number | null;
};

export async function linkAwardAwardee(input: LinkAwardAwardeeInput): Promise<void> {
  await db
    .insert(awardAwardees)
    .values({
      awardId: input.awardId,
      supplierId: input.supplierId,
      role: input.role ?? 'prime',
      sharePct: input.sharePct != null ? String(input.sharePct) : null,
    })
    .onConflictDoNothing();
}
