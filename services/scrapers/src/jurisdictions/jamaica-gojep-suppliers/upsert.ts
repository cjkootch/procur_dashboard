import { and, eq } from 'drizzle-orm';
import {
  db,
  externalSuppliers,
  jurisdictions,
  type NewExternalSupplier,
} from '@procur/db';
import { parse, parseISO, isValid } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import type { SupplierRow } from './scraper';

export type UpsertSuppliersResult = {
  inserted: number;
  updated: number;
  skipped: number;
};

const REG_DATE_FORMATS = ['dd-MM-yyyy HH:mm:ss', 'dd-MM-yyyy', 'yyyy-MM-dd'] as const;

function parseRegistrationDate(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const iso = parseISO(trimmed);
  if (isValid(iso)) return iso;

  for (const fmt of REG_DATE_FORMATS) {
    const parsed = parse(trimmed, fmt, new Date(0));
    if (isValid(parsed)) {
      try {
        return fromZonedTime(parsed, 'America/Jamaica');
      } catch {
        return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Upsert a batch of supplier rows into `external_suppliers`. Dedupe key
 * is `(jurisdictionId, sourceName, sourceReferenceId)`. On conflict we
 * refresh the contact fields (suppliers update their address/phone in
 * the registry) and bump `lastSeenAt` so downstream queries can rank
 * by recency.
 */
export async function upsertSuppliers(
  jurisdictionSlug: string,
  sourceName: string,
  rows: SupplierRow[],
): Promise<UpsertSuppliersResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const jurisdiction = await db.query.jurisdictions.findFirst({
    where: eq(jurisdictions.slug, jurisdictionSlug),
    columns: { id: true },
  });
  if (!jurisdiction) {
    throw new Error(
      `jurisdiction '${jurisdictionSlug}' not found — run db:seed first`,
    );
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Drizzle's onConflictDoUpdate doesn't return per-row insert/update
  // counts, so we look up existence per row first. Fine at the volume
  // we expect (~1,500 rows once-a-day).
  for (const row of rows) {
    const existing = await db.query.externalSuppliers.findFirst({
      where: and(
        eq(externalSuppliers.jurisdictionId, jurisdiction.id),
        eq(externalSuppliers.sourceName, sourceName),
        eq(externalSuppliers.sourceReferenceId, row.sourceReferenceId),
      ),
      columns: { id: true },
    });

    const now = new Date();
    const values: NewExternalSupplier = {
      jurisdictionId: jurisdiction.id,
      sourceName,
      sourceReferenceId: row.sourceReferenceId,
      sourceCategory: row.sourceCategory,
      sourceUrl: row.sourceUrl,
      organisationName: row.organisationName,
      address: row.address ?? null,
      phone: row.phone ?? null,
      email: row.email ?? null,
      country: row.country ?? null,
      contactPerson: row.contactPerson ?? null,
      registeredAt: parseRegistrationDate(row.registeredAtText) ?? null,
      rawData: { rawCells: row.rawCells },
      lastSeenAt: now,
      updatedAt: now,
    };

    if (existing) {
      // Don't touch firstSeenAt / createdAt on update.
      const { ...updateValues } = values;
      delete (updateValues as Record<string, unknown>)['firstSeenAt'];
      delete (updateValues as Record<string, unknown>)['createdAt'];
      await db
        .update(externalSuppliers)
        .set(updateValues)
        .where(eq(externalSuppliers.id, existing.id));
      updated += 1;
    } else {
      await db.insert(externalSuppliers).values(values);
      inserted += 1;
    }
  }

  void skipped;
  return { inserted, updated, skipped };
}
