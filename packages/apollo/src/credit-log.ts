import { db, apolloCreditLog, type NewApolloCreditLogEntry } from '@procur/db';
import type { ApolloEndpoint } from './config';

/**
 * Append-only log of Apollo API calls. Rows track the call, the
 * response status, the duration, and (eventually) the credit cost
 * inferred from the plan rules.
 *
 * Used for monthly burn observability and to verify that internal
 * rate limiting is keeping us below Apollo's 600/hr per-endpoint
 * cap. Not user-facing.
 */
export type LogApolloCallArgs = {
  endpoint: ApolloEndpoint;
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
