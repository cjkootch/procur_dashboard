import { APOLLO_RATE_LIMIT_PER_HOUR } from './config';

/**
 * In-process token-bucket rate limiter for Apollo API calls.
 *
 * Sized to APOLLO_RATE_LIMIT_PER_HOUR (default 500/hr) — under
 * Apollo's hard 600/hr per-endpoint cap so concurrent jobs running
 * from different processes still leave headroom. The token-bucket
 * is process-local; multi-process deployments need a shared
 * (Redis) bucket. v1 runs the cron + on-demand from the same
 * service so process-local is enough.
 *
 * Returns true if the call can proceed; false if the bucket is
 * empty. Callers are expected to either defer (cron) or surface
 * a "rate-limited" degrade signal (on-demand).
 */
export class ApolloRateLimiter {
  private callTimestamps: number[] = [];

  constructor(private readonly capacityPerHour: number = APOLLO_RATE_LIMIT_PER_HOUR) {}

  tryAcquire(): boolean {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    this.callTimestamps = this.callTimestamps.filter((t) => t > windowStart);
    if (this.callTimestamps.length >= this.capacityPerHour) {
      return false;
    }
    this.callTimestamps.push(now);
    return true;
  }

  /** Inspector — useful for logging when a call defers. */
  remainingCapacity(): number {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const recentCount = this.callTimestamps.filter((t) => t > windowStart).length;
    return Math.max(0, this.capacityPerHour - recentCount);
  }
}

/**
 * Module-level shared limiter. Use this for production code so the
 * same bucket is shared across enrichOrgFromApollo, enrichOrgsBatch,
 * and searchOrgs calls in the same process. Tests can construct
 * their own ApolloRateLimiter with a custom capacity.
 */
export const sharedRateLimiter = new ApolloRateLimiter();
