import type Anthropic from '@anthropic-ai/sdk';

/**
 * Optional Anthropic server-side tools exposed to the assistant.
 *
 * Server tools (web_search, web_fetch) execute entirely on
 * Anthropic's infrastructure — the model invokes them with a
 * server_tool_use block and the result flows back as a
 * web_search_tool_result block. Our local dispatcher in
 * stream.ts / loop.ts filters on b.type === 'tool_use', so these
 * blocks pass through naturally without needing a local handler.
 *
 * Gated behind ASSISTANT_WEB_SEARCH_ENABLED=1 so dev / staging
 * don't incur web-search billing (~$10 per 1,000 searches).
 * Production sets the env var on the deployment to flip it on.
 *
 * Notes from Anthropic's docs:
 *   - web_search_20260209 has dynamic filtering built in — the
 *     model writes and runs code to filter results before they hit
 *     the context window. Improves accuracy + token efficiency.
 *   - Do NOT declare a standalone code_execution tool alongside
 *     this version — it creates a second execution environment
 *     that can confuse the model.
 *   - max_uses caps how many times the tool can fire in a single
 *     turn. 5 is a sensible default for entity-research queries
 *     (search → consider → maybe one refinement search).
 */
export function getAnthropicServerTools(): Anthropic.Messages.ToolUnion[] {
  if (process.env.ASSISTANT_WEB_SEARCH_ENABLED !== '1') return [];
  return [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
    } as Anthropic.Messages.ToolUnion,
    {
      type: 'web_fetch_20260209',
      name: 'web_fetch',
      max_uses: 5,
    } as Anthropic.Messages.ToolUnion,
  ];
}
