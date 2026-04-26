import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

/**
 * Lazy singleton Anthropic client.
 *
 * Deferred init so modules importing `@procur/ai` at build time don't require
 * ANTHROPIC_API_KEY to be set (e.g. during `next build`). First call at
 * runtime reads the env var.
 *
 * If CF_AI_GATEWAY_BASE_URL is set, requests are routed through Cloudflare
 * AI Gateway for observability (per-call cost/latency dashboards),
 * automatic prompt caching across identical requests, and rate limiting.
 * Format: https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>
 * — provider segment ('/anthropic') is appended here.
 */
export function getClient(): Anthropic {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set — populate .env.local or Trigger.dev project env',
      );
    }
    const gatewayBase = process.env.CF_AI_GATEWAY_BASE_URL;
    cached = new Anthropic({
      baseURL: gatewayBase
        ? `${gatewayBase.replace(/\/$/, '')}/anthropic`
        : undefined,
    });
  }
  return cached;
}

// Model routing per brief: Haiku for light tasks, Sonnet for structured extraction.
export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];
