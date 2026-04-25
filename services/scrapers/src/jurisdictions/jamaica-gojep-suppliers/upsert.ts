import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
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
 *
 * Performance: groups inserts into chunks of `BATCH_SIZE` and uses
 * Drizzle's onConflictDoUpdate so the entire batch is one round-trip.
 * The naive per-row "select then insert/update" version was 2N queries
 * — 8k round-trips for the ~4k-row live registry, ~30min real-time
 * over Neon HTTP. Batching brings it under a minute.
 *
 * Trade-off: we lose the precise per-row inserted-vs-updated counter
 * (Postgres returns affected-row counts but doesn't per-row tag which
 * was an insert vs an update on a single conflict-resolution pass).
 * We approximate by counting rows that didn't exist before the batch.
 */
const BATCH_SIZE = 100;

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

  // Pre-count existing rows so we can report inserted-vs-updated
  // accurately. Single COUNT query, fine even at 4k rows.
  const existingRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(externalSuppliers)
    .where(eq(externalSuppliers.sourceName, sourceName));
  const beforeCount = existingRow[0]?.count ?? 0;

  let processed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const now = new Date();
    const values: NewExternalSupplier[] = chunk.map((row) => ({
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
    }));

    await db
      .insert(externalSuppliers)
      .values(values)
      .onConflictDoUpdate({
        target: [
          externalSuppliers.jurisdictionId,
          externalSuppliers.sourceName,
          externalSuppliers.sourceReferenceId,
        ],
        set: {
          sourceCategory: sql`excluded.source_category`,
          sourceUrl: sql`excluded.source_url`,
          organisationName: sql`excluded.organisation_name`,
          address: sql`excluded.address`,
          phone: sql`excluded.phone`,
          email: sql`excluded.email`,
          country: sql`excluded.country`,
          contactPerson: sql`excluded.contact_person`,
          registeredAt: sql`excluded.registered_at`,
          rawData: sql`excluded.raw_data`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    processed += chunk.length;
  }

  const afterRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(externalSuppliers)
    .where(eq(externalSuppliers.sourceName, sourceName));
  const afterCount = afterRow[0]?.count ?? 0;
  const inserted = Math.max(0, afterCount - beforeCount);
  const updated = Math.max(0, processed - inserted);

  return { inserted, updated, skipped: 0 };
}
