/**
 * Apollo enrichment for known_entities.
 *
 * Targets rolodex rows that don't yet have a primary_domain — the
 * GAIN-promoted entities mostly, since their auto-create path
 * didn't run Apollo. Also picks up legacy hand-seeded entries that
 * never got enriched.
 *
 * Mirrors usda-fsis-mpi-enrich.ts but reads from / writes to
 * known_entities directly. Apollo's mixed_companies/search is the
 * single tool — we ask by name + country, take the top hit, stamp:
 *
 *   - apollo_org_id
 *   - primary_domain
 *   - apollo_estimated_employees + apollo_annual_revenue +
 *     apollo_funding_stage / latest_funding_at / total_funding
 *     (when present on the snapshot)
 *   - apollo_snapshot (full raw response for audit)
 *   - apollo_synced_at = NOW()
 *
 * Idempotent on `apollo_synced_at` — already-synced rows skip
 * until `staleHours` elapses (default: never re-run; pass
 * staleHours=24*30 for monthly refresh).
 *
 * Filter modes:
 *   - tagFilter: only enrich entities carrying this tag
 *     (e.g. 'gain-curated' for the cohort that needs it most)
 *   - countryFilter: ISO-2; default: all
 *   - missingDomainOnly: when true (default), skip rows that
 *     already have a primary_domain even if apollo_synced_at is null
 */

import { sql, isNull, lt, or } from 'drizzle-orm';
import { type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { searchOrgs } from './org-service';

type Db = ReturnType<typeof drizzleType<typeof schema>>;

export interface KnownEntitiesEnrichArgs {
  /** Max rows to process this run. Default 200. */
  limit?: number;
  /** Re-enrich rows whose apollo_synced_at is older than this many
   *  hours. Default `Infinity` — never re-run on already-synced rows. */
  staleHours?: number;
  /** Filter to entities carrying this tag (e.g. 'gain-curated'). */
  tagFilter?: string;
  /** ISO-2 country filter. */
  countryFilter?: string;
  /** When true (default), skip rows that already have a primary_domain.
   *  Set false to refresh apollo fields on rows with a stale domain. */
  missingDomainOnly?: boolean;
}

export interface KnownEntitiesEnrichResult {
  processed: number;
  matched: number;
  unmatched: number;
  errors: number;
  remaining: number;
  apolloCalls: number;
  firstDegradeReason: string | null;
}

export async function enrichKnownEntitiesViaApollo(
  db: Db,
  args: KnownEntitiesEnrichArgs = {},
): Promise<KnownEntitiesEnrichResult> {
  const limit = args.limit ?? 200;
  const staleHours = args.staleHours ?? Number.POSITIVE_INFINITY;
  const missingDomainOnly = args.missingDomainOnly ?? true;

  // Build the pending-row filter.
  //
  // `pendingCondition` covers freshness — either never synced OR
  // synced longer ago than staleHours.
  const pendingCondition = Number.isFinite(staleHours)
    ? or(
        isNull(schema.knownEntities.apolloSyncedAt),
        lt(
          schema.knownEntities.apolloSyncedAt,
          new Date(Date.now() - staleHours * 60 * 60 * 1000),
        ),
      )
    : isNull(schema.knownEntities.apolloSyncedAt);

  const conds: ReturnType<typeof sql>[] = [];
  if (pendingCondition) conds.push(sql`${pendingCondition}`);
  if (missingDomainOnly) {
    conds.push(sql`${schema.knownEntities.primaryDomain} IS NULL`);
  }
  if (args.tagFilter) {
    conds.push(sql`${args.tagFilter} = ANY(${schema.knownEntities.tags})`);
  }
  if (args.countryFilter) {
    conds.push(sql`${schema.knownEntities.country} = ${args.countryFilter}`);
  }
  const whereClause = sql.join(conds, sql` AND `);

  const rows = await db
    .select({
      slug: schema.knownEntities.slug,
      name: schema.knownEntities.name,
      country: schema.knownEntities.country,
    })
    .from(schema.knownEntities)
    .where(whereClause)
    .orderBy(schema.knownEntities.slug)
    .limit(limit);

  let matched = 0;
  let unmatched = 0;
  let errors = 0;
  let apolloCalls = 0;
  let firstDegradeReason: string | null = null;

  for (const row of rows) {
    const locationHint = row.country ? [row.country] : ['United States'];

    try {
      const result = await searchOrgs(
        {
          organizationName: row.name,
          organizationLocations: locationHint,
        },
        { perPage: 1 },
      );
      apolloCalls += 1;

      if ('ok' in result && result.ok === false) {
        if (!firstDegradeReason) {
          firstDegradeReason = `${result.reason}: ${result.message}`.slice(0, 200);
        }
        errors += 1;
        continue;
      }

      const first =
        'organizations' in result ? result.organizations[0] : undefined;
      if (!first) {
        // Apollo has no record. Stamp apollo_synced_at so we don't
        // re-query until staleHours elapses.
        await db
          .update(schema.knownEntities)
          .set({
            apolloSyncedAt: sql`NOW()`,
          })
          .where(sql`${schema.knownEntities.slug} = ${row.slug}`);
        unmatched += 1;
        continue;
      }

      // The search endpoint returns ApolloOrgThin (id, primaryDomain,
      // websiteUrl, foundedYear). Funding / employee / revenue need
      // a follow-up organizations/{id} single-get, which costs more
      // credits — left out of the bulk enrichment. The chat tools'
      // apollo fields will stay null until a targeted single-get pass
      // runs (or until the operator visits the entity profile, which
      // triggers an on-demand enrichment elsewhere).
      const updates: Record<string, unknown> = {
        apolloOrgId: first.id,
        primaryDomain: first.primaryDomain ?? null,
        apolloSyncedAt: sql`NOW()`,
        apolloSnapshot: first as unknown as Record<string, unknown>,
      };

      await db
        .update(schema.knownEntities)
        .set(updates)
        .where(sql`${schema.knownEntities.slug} = ${row.slug}`);
      matched += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'known-entities-apollo-enrich',
          msg: 'per-row failure — continuing',
          slug: row.slug,
          name: row.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Remaining tally.
  const remainingResult = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.knownEntities)
    .where(whereClause);
  const remaining = remainingResult[0]?.n ?? 0;

  return {
    processed: rows.length,
    matched,
    unmatched,
    errors,
    remaining,
    apolloCalls,
    firstDegradeReason,
  };
}
