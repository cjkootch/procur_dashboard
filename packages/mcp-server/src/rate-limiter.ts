import { MCP_RATE_LIMIT_PER_HOUR } from './config';

/**
 * In-process token-bucket rate limiter, scoped per-API-key.
 *
 * Spec: docs/mcp-server-brief.md §3.2. 1,000 calls/hr/key. Process-
 * local — multi-process deployments need a Redis bucket; v1 runs
 * MCP traffic from one Vercel function instance per request, so
 * the per-process state is sufficient for the per-tenant cap not
 * to be wildly inaccurate.
 *
 * The trade-off is that Vercel's serverless cold starts wipe the
 * bucket. In practice this is forgiving — bursts are rare and the
 * 1,000/hr ceiling is high enough that operators won't hit it
 * legitimately. Abuse detection happens at the mcp_tool_call_log
 * layer, not here.
 */
export class McpRateLimiter {
  private byKey: Map<string, number[]> = new Map();

  constructor(private readonly capacityPerHour: number = MCP_RATE_LIMIT_PER_HOUR) {}

  tryAcquire(apiKeyId: string): boolean {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const timestamps = (this.byKey.get(apiKeyId) ?? []).filter(
      (t) => t > windowStart,
    );
    if (timestamps.length >= this.capacityPerHour) {
      this.byKey.set(apiKeyId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.byKey.set(apiKeyId, timestamps);
    return true;
  }

  remainingCapacity(apiKeyId: string): number {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const recent = (this.byKey.get(apiKeyId) ?? []).filter((t) => t > windowStart);
    return Math.max(0, this.capacityPerHour - recent.length);
  }
}

/** Module-level shared limiter — one bucket across all callers in
 *  this process. */
export const sharedMcpRateLimiter = new McpRateLimiter();
