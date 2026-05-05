import { performance } from 'node:perf_hooks';
import { loadApolloConfig, type ApolloEndpoint } from './config';
import { sharedRateLimiter } from './rate-limiter';
import { logApolloCall } from './credit-log';
import type { ApolloDegradeResult } from './types';

/**
 * Shared Apollo HTTP transport. Every service-layer function that
 * calls the Apollo API funnels through `apolloFetch` so:
 *   - APOLLO_ENABLED gate is checked once
 *   - master key is attached uniformly
 *   - rate limit is acquired once per call
 *   - retries on 429 use one consistent backoff schedule
 *   - every call gets a credit-log row regardless of outcome
 *
 * The function returns a discriminated union: either the parsed JSON
 * body, or an ApolloDegradeResult with the reason a non-throwing
 * degrade happened (rate limit, feature flag, missing key, 4xx that
 * the caller should map to "no match", etc.).
 *
 * 401 throws — a misconfigured key is a real bug, not a runtime
 * degrade. Everything else degrades gracefully.
 */

export type ApolloFetchSuccess<T> = { ok: true; data: T; httpStatus: number };
export type ApolloFetchResult<T> = ApolloFetchSuccess<T> | ApolloDegradeResult;

const RETRY_DELAYS_MS = [1_000, 2_500, 6_000, 15_000];

export async function apolloFetch<T>(args: {
  endpoint: ApolloEndpoint;
  /** URL path relative to APOLLO_BASE_URL. Include leading slash. */
  path: string;
  method: 'GET' | 'POST';
  /** JSON body for POST. */
  body?: unknown;
  /** Hash for credit-log dedup detection. Optional. */
  argsHash?: string;
  /** Echoed into the credit-log row. Optional. */
  page?: number;
  perPage?: number;
}): Promise<ApolloFetchResult<T>> {
  const config = loadApolloConfig();

  if (!config.enabled) {
    await logApolloCall({
      endpoint: args.endpoint,
      argsHash: args.argsHash,
      page: args.page,
      perPage: args.perPage,
      errorCode: 'feature-flag-disabled',
    });
    return {
      ok: false,
      reason: 'feature-flag-disabled',
      message: 'APOLLO_ENABLED is not set to true; skipping live call.',
    };
  }

  if (!config.masterApiKey) {
    await logApolloCall({
      endpoint: args.endpoint,
      argsHash: args.argsHash,
      errorCode: 'no-master-key',
    });
    return {
      ok: false,
      reason: 'no-master-key',
      message: 'APOLLO_MASTER_API_KEY env var is not set.',
    };
  }

  if (!sharedRateLimiter.tryAcquire()) {
    await logApolloCall({
      endpoint: args.endpoint,
      argsHash: args.argsHash,
      errorCode: 'rate-limited-internally',
      notes: `bucket-empty: ${sharedRateLimiter.remainingCapacity()} remaining`,
    });
    return {
      ok: false,
      reason: 'rate-limited-internally',
      message: 'Apollo rate-limit bucket is empty for this hour.',
    };
  }

  const url = `${config.baseUrl}${args.path}`;
  const headers: Record<string, string> = {
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/json',
    'X-Api-Key': config.masterApiKey,
    Accept: 'application/json',
  };

  let attempt = 0;
  let lastErrorCode = 'apollo-transport-error';
  let lastHttpStatus: number | undefined;

  while (attempt < RETRY_DELAYS_MS.length) {
    const started = performance.now();
    try {
      const res = await fetch(url, {
        method: args.method,
        headers,
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      const durationMs = Math.round(performance.now() - started);
      lastHttpStatus = res.status;

      if (res.status === 200) {
        const data = (await res.json()) as T;
        await logApolloCall({
          endpoint: args.endpoint,
          argsHash: args.argsHash,
          page: args.page,
          perPage: args.perPage,
          httpStatus: 200,
          durationMs,
        });
        return { ok: true, data, httpStatus: 200 };
      }

      if (res.status === 401) {
        await logApolloCall({
          endpoint: args.endpoint,
          argsHash: args.argsHash,
          httpStatus: 401,
          durationMs,
          errorCode: 'apollo-401',
        });
        // 401 = misconfigured key. Real bug, not a degrade.
        throw new Error(
          `Apollo returned 401 (Invalid access credentials). Check APOLLO_MASTER_API_KEY.`,
        );
      }

      if (res.status === 403) {
        await logApolloCall({
          endpoint: args.endpoint,
          argsHash: args.argsHash,
          httpStatus: 403,
          durationMs,
          errorCode: 'apollo-403',
        });
        return {
          ok: false,
          reason: 'apollo-403',
          message: `Apollo 403: endpoint ${args.endpoint} requires master API key (or plan tier missing access).`,
        };
      }

      if (res.status === 422) {
        await logApolloCall({
          endpoint: args.endpoint,
          argsHash: args.argsHash,
          httpStatus: 422,
          durationMs,
          errorCode: 'apollo-422',
        });
        return {
          ok: false,
          reason: 'apollo-422',
          message: `Apollo 422: invalid parameters or no record (${args.endpoint}).`,
        };
      }

      if (res.status === 429) {
        lastErrorCode = 'apollo-429';
        await logApolloCall({
          endpoint: args.endpoint,
          argsHash: args.argsHash,
          httpStatus: 429,
          durationMs,
          errorCode: 'apollo-429',
          notes: `attempt ${attempt + 1}`,
        });
        // Apollo's external rate limit kicked in despite our internal
        // bucket. Back off + retry.
        await sleep(RETRY_DELAYS_MS[attempt]!);
        attempt += 1;
        continue;
      }

      // Any other 4xx/5xx: log + degrade.
      await logApolloCall({
        endpoint: args.endpoint,
        argsHash: args.argsHash,
        httpStatus: res.status,
        durationMs,
        errorCode: 'apollo-transport-error',
        notes: `unexpected status ${res.status}`,
      });
      return {
        ok: false,
        reason: 'apollo-transport-error',
        message: `Apollo returned unexpected ${res.status} for ${args.endpoint}.`,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      // Network / fetch failure. Retry.
      lastErrorCode = 'apollo-transport-error';
      await logApolloCall({
        endpoint: args.endpoint,
        argsHash: args.argsHash,
        durationMs,
        errorCode: 'apollo-transport-error',
        notes: err instanceof Error ? err.message : String(err),
      });
      if (attempt + 1 >= RETRY_DELAYS_MS.length) {
        throw err;
      }
      await sleep(RETRY_DELAYS_MS[attempt]!);
      attempt += 1;
    }
  }

  return {
    ok: false,
    reason: lastErrorCode === 'apollo-429' ? 'apollo-429' : 'apollo-transport-error',
    message:
      lastHttpStatus === 429
        ? `Apollo 429 — exhausted ${RETRY_DELAYS_MS.length} retry attempts.`
        : `Apollo transport failed after ${RETRY_DELAYS_MS.length} attempts.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
