import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  db,
  apolloCreditLog,
  type NewApolloCreditLogEntry,
} from '@procur/db';
import {
  APOLLO_PEOPLE_ENRICHMENT_ENDPOINTS,
  type ApolloEndpoint,
} from './config';

/**
 * Append-only log of Apollo API calls. Rows track the call, the
 * response status, the duration, and (eventually) the credit cost
 * inferred from the plan rules.
 *
 * Used for monthly burn observability, to verify internal rate
 * limiting stays under Apollo's 600/hr per-endpoint cap, and to
 * enforce the per-tenant per-day people-enrichment cap (apollo
 * brief §11). Not user-facing.
 */
export type LogApolloCallArgs = {
  endpoint: ApolloEndpoint;
  /** Tenant scope. NULL for cron-driven calls (batch enrichment,
   *  saved-search runner); required for on-demand calls so the
   *  per-tenant per-day cap can be counted. */
  companyId?: string;
  argsHash?: string;
  page?: number;
  perPage?: number;
  httpStatus?: number;
  creditsSpent?: number;
  durationMs?: number;
  errorCode?: string;
  notes?: string;
};

export async function logApolloCall(args: LogApolloCallArgs): Promise<void> {
  const row: NewApolloCreditLogEntry = {
    endpoint: args.endpoint,
    companyId: args.companyId ?? null,
    argsHash: args.argsHash ?? null,
    page: args.page ?? null,
    perPage: args.perPage ?? null,
    httpStatus: args.httpStatus ?? null,
    creditsSpent: args.creditsSpent ?? null,
    durationMs: args.durationMs ?? null,
    errorCode: args.errorCode ?? null,
    notes: args.notes ?? null,
  };
  await db.insert(apolloCreditLog).values(row);
}

/**
 * Stable string used to dedup-detect identical calls in the log.
 * Hashed with whatever the caller wants (shake256, fnv, sha-1) —
 * we don't dictate the algorithm because the field is informational,
 * not a uniqueness key.
 */
export function describeApolloCallArgs(args: Record<string, unknown>): string {
  // Deterministic key order for matching across calls with same args.
  const sortedKeys = Object.keys(args).sort();
  const parts: string[] = [];
  for (const k of sortedKeys) {
    const v = args[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join('&');
}

/**
 * Count successful people-enrichment calls for a tenant in the
 * trailing 24 hours. Used to enforce the per-tenant per-day cap
 * (default 25, settable upward in admin) before enrichPerson /
 * enrichPeopleBulk fires.
 *
 * Counts both /people/match and /people/bulk_match — bulk-match
 * resolves multiple people in a single call but each call still
 * counts as one row in the log. The cap is on number of API calls,
 * not number of resolved people.
 */
export async function countPeopleEnrichmentsLastDay(args: {
  companyId: string;
}): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apolloCreditLog)
    .where(
      and(
        eq(apolloCreditLog.companyId, args.companyId),
        gte(apolloCreditLog.calledAt, since),
        eq(apolloCreditLog.httpStatus, 200),
        inArray(
          apolloCreditLog.endpoint,
          APOLLO_PEOPLE_ENRICHMENT_ENDPOINTS as unknown as string[],
        ),
      ),
    );
  return rows[0]?.count ?? 0;
}
