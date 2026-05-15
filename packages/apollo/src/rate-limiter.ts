const DEFAULT_RATE_LIMIT_PER_HOUR = 500;

/**
 * Read the rate-limit cap lazily — on every check — so CLI scripts
 * that call `dotenv` AFTER `@procur/apollo` is imported still get
 * their overrides honored. (Module-load capture used to silently
 * stick the default; bulk seed runs would hit 500/hr regardless of
 * APOLLO_RATE_LIMIT_PER_HOUR.)
 */
function readRateLimitFromEnv(): number {
  const raw = process.env.APOLLO_RATE_LIMIT_PER_HOUR;
  if (!raw) return DEFAULT_RATE_LIMIT_PER_HOUR;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_LIMIT_PER_HOUR;
}

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
 *
 * Constructor cap is optional — when omitted, the limiter reads
 * `APOLLO_RATE_LIMIT_PER_HOUR` on every check so dotenv-loaded
 * overrides land even if dotenv runs after this module imports.
 */
export class ApolloRateLimiter {
  private callTimestamps: number[] = [];
  private readonly explicitCapacity: number | null;

  constructor(capacityPerHour?: number) {
    this.explicitCapacity = capacityPerHour ?? null;
  }

  private currentCapacity(): number {
    return this.explicitCapacity ?? readRateLimitFromEnv();
  }

  tryAcquire(): boolean {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    this.callTimestamps = this.callTimestamps.filter((t) => t > windowStart);
    if (this.callTimestamps.length >= this.currentCapacity()) {
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
    return Math.max(0, this.currentCapacity() - recentCount);
  }
}

/**
 * Module-level shared limiter. Use this for production code so the
 * same bucket is shared across enrichOrgFromApollo, enrichOrgsBatch,
 * and searchOrgs calls in the same process. Tests can construct
 * their own ApolloRateLimiter with a custom capacity.
 */
export const sharedRateLimiter = new ApolloRateLimiter();
