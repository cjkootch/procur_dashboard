import type Anthropic from '@anthropic-ai/sdk';

/**
 * Build the system blocks for a per-opportunity AI task.
 *
 * Layout:
 *   [0] Document text (cached 1h — reusable across classify/summarize/extract for the same opportunity)
 *   [1] Task-specific instruction (not cached — differs per task)
 *
 * Render order in the Messages API is `tools → system → messages`, and a
 * `cache_control` breakpoint caches everything up to and including that block.
 * Putting the document first means subsequent calls for the same opportunity
 * read from cache (~0.1x cost) while the instruction varies per task.
 *
 * Minimum cacheable prefix:
 *   - Haiku 4.5:  4096 tokens (cache silently no-ops below this)
 *   - Sonnet 4.6: 2048 tokens
 * If docText is small or missing, we skip the cached block entirely.
 */
export function buildSystem(
  instruction: string,
  docText: string | undefined,
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  if (docText && docText.length > 2000) {
    blocks.push({
      type: 'text',
      text: `Tender source document:\n\n${docText}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }
  blocks.push({ type: 'text', text: instruction });
  return blocks;
}

export type CacheUsage = {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export function extractUsage(
  usage: Anthropic.Usage | undefined,
): CacheUsage {
  return {
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}
