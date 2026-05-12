/**
 * Apollo enrichment for USDA FSIS MPI establishments.
 *
 * Walks `usda_fsis_establishments` rows that haven't been enriched yet
 * (or whose enrichment is stale), looks each up via Apollo's
 * `mixed_companies/search` by `legal_name + state`, and writes back
 * the thin fields (apollo_org_id, primary_domain, website_url) plus
 * sync timestamp.
 *
 * Scope deliberately stops at "thin" fields. Employees / revenue /
 * industry / short_description need Apollo's single-get
 * (`/organizations/{id}`) which costs more credits — that's a
 * follow-up tool the operator triggers selectively on top-N
 * establishments after seeing which ones Apollo even matched.
 *
 * Rate-limit handling: @procur/apollo's transport has built-in
 * token-bucket + 429 retry. We just call per-row sequentially and
 * trust the layer below.
 *
 * Batching: a single call to this function processes UP TO `limit`
 * rows. Caller decides whether to loop until done (CLI) or do a
 * single bounded run (admin route within Vercel maxDuration).
 *
 * Idempotent: `apollo_synced_at` gates re-enrichment via the
 * `staleHours` arg. Default is "never re-run on already-synced rows"
 * — pass `staleHours: 24 * 30` to refresh monthly.
 */

import { sql, and, isNull, lt, or } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle, type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { searchOrgs } from './org-service';

type Db = ReturnType<typeof drizzleType<typeof schema>>;

export interface EnrichmentResult {
  processed: number;
  matched: number;
  unmatched: number;
  errors: number;
  /** Approximate count of rows still pending after this run.
   *  Computed via a single COUNT query at the end. */
  remaining: number;
  /** Apollo API calls actually issued — useful for credit tracking. */
  apolloCalls: number;
}

export interface EnrichMpiArgs {
  /** Max rows to process this run. Default 200 (~1 minute at Apollo's
   *  typical pace; comfortably under Vercel maxDuration=300). */
  limit?: number;
  /** Re-enrich rows whose apollo_synced_at is older than this many
   *  hours. Default `Infinity` — never re-run on already-synced rows.
   *  Pass `24 * 30` to refresh monthly. */
  staleHours?: number;
  /** Filter to a specific species (e.g. 'swine'). Useful for "enrich
   *  just the pork processors first" sequencing. */
  speciesFilter?: string;
}

export async function enrichMpiEstablishmentsViaApollo(
  db: Db,
  args: EnrichMpiArgs = {},
): Promise<EnrichmentResult> {
  const limit = args.limit ?? 200;
  const staleHours = args.staleHours ?? Number.POSITIVE_INFINITY;

  const pendingCondition = Number.isFinite(staleHours)
    ? or(
        isNull(schema.usdaFsisEstablishments.apolloSyncedAt),
        lt(
          schema.usdaFsisEstablishments.apolloSyncedAt,
          new Date(Date.now() - staleHours * 60 * 60 * 1000),
        ),
      )
    : isNull(schema.usdaFsisEstablishments.apolloSyncedAt);

  const speciesCondition = args.speciesFilter
    ? sql`${schema.usdaFsisEstablishments.species} @> ARRAY[${args.speciesFilter}]::text[]`
    : undefined;

  const where = speciesCondition
    ? and(pendingCondition, speciesCondition)
    : pendingCondition;

  const rows = await db
    .select({
      establishmentNumber: schema.usdaFsisEstablishments.establishmentNumber,
      legalName: schema.usdaFsisEstablishments.legalName,
      state: schema.usdaFsisEstablishments.state,
    })
    .from(schema.usdaFsisEstablishments)
    .where(where)
    .orderBy(schema.usdaFsisEstablishments.establishmentNumber)
    .limit(limit);

  let matched = 0;
  let unmatched = 0;
  let errors = 0;
  let apolloCalls = 0;

  for (const row of rows) {
    // Bias the search to the establishment's US state when known.
    // Apollo's organizationLocations is a free-form array of place
    // strings; "Iowa, United States" works well for state-level
    // disambiguation across same-name companies.
    const locationHint = row.state
      ? [`${row.state}, United States`]
      : ['United States'];

    try {
      const result = await searchOrgs(
        {
          organizationName: row.legalName,
          organizationLocations: locationHint,
        },
        { perPage: 1 },
      );
      apolloCalls += 1;

      // ApolloDegradeResult discriminates on `ok: false`. Success
      // results don't carry an `ok` field — check via type narrowing.
      if ('ok' in result && result.ok === false) {
        // Degrade signal (rate-limited / feature-off / missing key).
        // Don't burn the row's pending status — leave it for retry.
        errors += 1;
        continue;
      }

      const first =
        'organizations' in result ? result.organizations[0] : undefined;
      if (!first) {
        // Apollo has no record for this establishment. Stamp
        // apollo_synced_at so we don't re-try until staleHours expires.
        await db
          .update(schema.usdaFsisEstablishments)
          .set({
            apolloSyncedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(
            sql`${schema.usdaFsisEstablishments.establishmentNumber} = ${row.establishmentNumber}`,
          );
        unmatched += 1;
        continue;
      }

      await db
        .update(schema.usdaFsisEstablishments)
        .set({
          apolloOrgId: first.id,
          primaryDomain: first.primaryDomain,
          websiteUrl: first.websiteUrl,
          apolloSyncedAt: sql`NOW()`,
          updatedAt: sql`NOW()`,
        })
        .where(
          sql`${schema.usdaFsisEstablishments.establishmentNumber} = ${row.establishmentNumber}`,
        );
      matched += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'fsis-apollo-enrich',
          msg: 'per-row failure — continuing',
          establishmentNumber: row.establishmentNumber,
          legalName: row.legalName,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Pending-count tally for operator progress feedback.
  const remainingResult = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usdaFsisEstablishments)
    .where(where);
  const remaining = remainingResult[0]?.n ?? 0;

  return {
    processed: rows.length,
    matched,
    unmatched,
    errors,
    remaining,
    apolloCalls,
  };
}

/**
 * Convenience wrapper: builds a Neon-HTTP drizzle client from
 * process.env.DATABASE_URL then calls enrichMpiEstablishmentsViaApollo.
 *
 * Used by the admin route. The CLI passes its own db so it can share
 * the connection with subsequent operations.
 */
export async function runMpiApolloEnrichment(
  args: EnrichMpiArgs = {},
): Promise<EnrichmentResult> {
  if (!process.env.DATABASE_URL) {
    throw new Error('runMpiApolloEnrichment: DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });
  return enrichMpiEstablishmentsViaApollo(db, args);
}
