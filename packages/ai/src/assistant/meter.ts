import { MODELS, type ModelName } from '../client';
import type { CacheUsage } from '../prompt-blocks';
import { recordUsage, type UsageSource } from './budget';
import { costUsdCentsForEmbedding, costUsdCentsForTurn } from './pricing';

/**
 * Record a single AI call against a company's usage. Call this from the
 * app-side wrapper of each AI task so platform-wide enrichment jobs
 * (which have no owning company) are not counted against customer budgets.
 */
export async function meter(params: {
  companyId: string;
  source: UsageSource;
  model: ModelName;
  usage: CacheUsage;
}): Promise<number> {
  const costCents = costUsdCentsForTurn(params.model, params.usage);
  await recordUsage({
    companyId: params.companyId,
    source: params.source,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    cacheCreationTokens: params.usage.cacheCreationTokens,
    cacheReadTokens: params.usage.cacheReadTokens,
    costUsdCents: costCents,
  });
  return costCents;
}

export async function meterEmbedding(params: {
  companyId: string;
  tokens: number;
}): Promise<number> {
  const costCents = costUsdCentsForEmbedding(params.tokens);
  await recordUsage({
    companyId: params.companyId,
    source: 'embeddings',
    inputTokens: params.tokens,
    costUsdCents: costCents,
  });
  return costCents;
}

export { MODELS };
