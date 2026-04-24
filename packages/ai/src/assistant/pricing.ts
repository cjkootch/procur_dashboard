import { MODELS, type ModelName } from '../client';
import type { CacheUsage } from '../prompt-blocks';

/**
 * USD prices per million tokens. Keep this file as the single source of truth
 * for cost math — updating it should propagate to assistant usage and budget
 * enforcement everywhere.
 *
 * Reference: anthropic.com/pricing (Claude 4 series).
 */
const PRICES_PER_MTOK: Record<ModelName, {
  input: number;
  output: number;
  cacheWrite: number; // 1h TTL rate
  cacheRead: number;
}> = {
  [MODELS.haiku]: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  [MODELS.sonnet]: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

/** Embeddings (OpenAI text-embedding-3-small). */
const EMBEDDING_PRICE_PER_MTOK = 0.02;

export function costUsdCentsForTurn(model: ModelName, usage: CacheUsage): number {
  const p = PRICES_PER_MTOK[model];
  if (!p) return 0;
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) /
    1_000_000;
  return Math.round(usd * 100);
}

export function costUsdCentsForEmbedding(tokens: number): number {
  return Math.round((tokens * EMBEDDING_PRICE_PER_MTOK) / 1_000_000 * 100);
}
