import type Anthropic from '@anthropic-ai/sdk';
import { getClient, MODELS } from '../client';
import { BudgetExceededError, getBudgetStatus, recordUsage } from './budget';
import { costUsdCentsForTurn } from './pricing';
import { PostgresCostLedger } from '../cost-ledger';

// Vex-into-procur merge Phase 2 — every Anthropic call dual-writes to
// cost_ledger AND the existing ai_usage rollup. cost_ledger is the
// per-call audit / source of truth; ai_usage stays the fast daily
// aggregate consulted by the budget gate.
const costLedger = new PostgresCostLedger();
import { buildAssistantSystem } from './system-prompt';
import { buildToolsParam } from './tools/registry';
import { getAnthropicServerTools } from './server-tools';
import type { AssistantContext, ToolRegistry } from './types';
import { DEFAULT_ASSISTANT_MAX_TOKENS } from './types';

const DEFAULT_MAX_STEPS = 8;

export type TurnInput = {
  ctx: AssistantContext;
  tools: ToolRegistry;
  /** Prior messages in the thread, in Anthropic MessageParam shape. */
  history: Anthropic.MessageParam[];
  /** The new user message text. */
  userText: string;
  companyName: string;
  userFirstName?: string | null;
  planTier: string;
  maxSteps?: number;
};

export type TurnStep =
  | { type: 'assistant_message'; content: Anthropic.ContentBlock[]; stopReason: string | null; usage: Anthropic.Usage }
  | { type: 'tool_result'; toolUseId: string; toolName: string; output: unknown; isError: boolean };

export type TurnResult = {
  steps: TurnStep[];
  finalMessages: Anthropic.MessageParam[];
  totalCostCents: number;
};

/**
 * Add an ephemeral cache_control breakpoint to the LAST content block
 * of the LAST message. The Anthropic Messages API caches everything
 * up to and including the breakpoint at 0.1x read cost on subsequent
 * calls within the TTL.
 *
 * Why on EVERY messages.create call (not just at turn end):
 *   - Within a single turn, the agent loops on tool_use. Each iteration
 *     re-sends all accumulated messages. Setting the breakpoint on the
 *     last message every iteration makes every iteration after the
 *     first read its prior steps from cache.
 *   - Across turns, when the next user message arrives the prior
 *     turn's final assistant response sits at the breakpoint, so the
 *     entire prior conversation reads from cache.
 *
 * Breakpoint accounting (Anthropic caps at 4 per request):
 *   - system block #1: 1 breakpoint (cached statically)
 *   - system block #2: 1 breakpoint (cached statically)
 *   - last message:    1 breakpoint (this function)
 *   - total: 3, well under the cap.
 *
 * The returned array is a shallow clone — the caller's array is not
 * mutated, and the last message itself is cloned (with its content
 * cloned to add the cache_control on the last block).
 */
function withCacheControlOnLast(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  const cacheBreakpoint = { type: 'ephemeral' as const, ttl: '1h' as const };

  if (typeof last.content === 'string') {
    return [
      ...messages.slice(0, lastIdx),
      {
        role: last.role,
        content: [
          { type: 'text', text: last.content, cache_control: cacheBreakpoint },
        ],
      },
    ];
  }

  if (!Array.isArray(last.content) || last.content.length === 0) {
    return messages;
  }

  const lastBlockIdx = last.content.length - 1;
  const lastBlock = last.content[lastBlockIdx]!;
  return [
    ...messages.slice(0, lastIdx),
    {
      role: last.role,
      content: [
        ...last.content.slice(0, lastBlockIdx),
        { ...lastBlock, cache_control: cacheBreakpoint },
      ],
    } as Anthropic.MessageParam,
  ];
}

/**
 * Run one agentic turn: send user → loop on tool_use → return final messages
 * with all intermediate steps preserved. Writes a usage row for every model
 * call. The caller is responsible for persisting messages.
 */
export async function runAgentTurn(input: TurnInput): Promise<TurnResult> {
  const budget = await getBudgetStatus(input.ctx.companyId);
  if (budget.exceeded) throw new BudgetExceededError(budget);

  const client = getClient();
  const system = buildAssistantSystem({
    companyName: input.companyName,
    userFirstName: input.userFirstName,
    planTier: input.planTier,
    pageContext: input.ctx.pageContext,
  });
  const toolParams: Anthropic.Messages.ToolUnion[] = [
    ...buildToolsParam(input.tools),
    ...getAnthropicServerTools(),
  ];

  const messages: Anthropic.MessageParam[] = [
    ...input.history,
    { role: 'user', content: input.userText },
  ];

  const steps: TurnStep[] = [];
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  let totalCostCents = 0;
  // See stream.ts: web_search_20260209 / web_fetch_20260209 require
  // the container_id to be threaded forward across loop iterations
  // once they've fired.
  let containerId: string | null = null;

  for (let step = 0; step < maxSteps; step += 1) {
    const response: Anthropic.Message = await client.messages.create({
      model: MODELS.sonnet,
      max_tokens: DEFAULT_ASSISTANT_MAX_TOKENS,
      system,
      tools: toolParams,
      messages: withCacheControlOnLast(messages),
      container: containerId,
    });
    if (response.container?.id) containerId = response.container.id;

    const costCents = costUsdCentsForTurn(MODELS.sonnet, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });
    totalCostCents += costCents;
    await recordUsage({
      companyId: input.ctx.companyId,
      source: 'assistant',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      costUsdCents: costCents,
    });

    // cost_ledger dual-write — idempotent on response.id so retries +
    // partial-failure replays collapse to one row. Total tokens + total
    // cost in micros; per-token-class breakdown stays in ai_usage.
    const totalTokens =
      response.usage.input_tokens +
      response.usage.output_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    await costLedger.record({
      idempotencyKey: `assistant:${response.id}`,
      operation: 'llm.completion',
      provider: 'anthropic',
      model: MODELS.sonnet,
      units: totalTokens,
      unitKind: 'tokens',
      costUsdMicros: costCents * 10_000,
      occurredAt: new Date(),
    });

    steps.push({
      type: 'assistant_message',
      content: response.content,
      stopReason: response.stop_reason,
      usage: response.usage,
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return { steps, finalMessages: messages, totalCostCents };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const def = input.tools[use.name];
      if (!def) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        });
        steps.push({
          type: 'tool_result',
          toolUseId: use.id,
          toolName: use.name,
          output: { error: 'unknown_tool' },
          isError: true,
        });
        continue;
      }
      try {
        const parsed = def.schema.parse(use.input);
        const output = await def.handler(input.ctx, parsed);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(output).slice(0, 20000),
        });
        steps.push({
          type: 'tool_result',
          toolUseId: use.id,
          toolName: use.name,
          output,
          isError: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Tool error: ${msg}`,
          is_error: true,
        });
        steps.push({
          type: 'tool_result',
          toolUseId: use.id,
          toolName: use.name,
          output: { error: msg },
          isError: true,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`Agent loop exceeded ${maxSteps} steps without ending`);
}
