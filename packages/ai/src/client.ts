import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

/**
 * Lazy singleton Anthropic client.
 *
 * Deferred init so modules importing `@procur/ai` at build time don't require
 * ANTHROPIC_API_KEY to be set (e.g. during `next build`). First call at
 * runtime reads the env var.
 */
export function getClient(): Anthropic {
  if (!cached) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set — populate .env.local or Trigger.dev project env',
      );
    }
    cached = new Anthropic();
  }
  return cached;
}

// Model routing per brief: Haiku for light tasks, Sonnet for structured extraction.
export const MODELS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
} as const;

export type ModelName = (typeof MODELS)[keyof typeof MODELS];
