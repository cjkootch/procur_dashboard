import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../client';
import { costUsdCentsForTurn, costUsdCentsForEmbedding } from './pricing';

describe('costUsdCentsForTurn', () => {
  it('prices a pure-input Sonnet call', () => {
    // 1M input @ $3 = $3.00 = 300c
    const cents = costUsdCentsForTurn(MODELS.sonnet, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    assert.equal(cents, 300);
  });

  it('prices input+output on Haiku', () => {
    // 100k in @ $1 = $0.10, 50k out @ $5 = $0.25 → $0.35 = 35c
    const cents = costUsdCentsForTurn(MODELS.haiku, {
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    assert.equal(cents, 35);
  });

  it('charges cache reads at 10% of Sonnet input', () => {
    // 1M cache reads @ $0.30 = $0.30 = 30c
    const cents = costUsdCentsForTurn(MODELS.sonnet, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    assert.equal(cents, 30);
  });

  it('rounds sub-cent costs', () => {
    // 1k input @ $3 = $0.003 → rounds to 0c
    const cents = costUsdCentsForTurn(MODELS.sonnet, {
      inputTokens: 1_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    assert.equal(cents, 0);
  });
});

describe('costUsdCentsForEmbedding', () => {
  it('prices embeddings at $0.02/M', () => {
    // 1M tokens @ $0.02 = 2c
    assert.equal(costUsdCentsForEmbedding(1_000_000), 2);
  });

  it('returns 0 for small batches', () => {
    assert.equal(costUsdCentsForEmbedding(1000), 0);
  });
});
