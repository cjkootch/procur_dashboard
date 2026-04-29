import type Anthropic from '@anthropic-ai/sdk';
import { getClient, MODELS } from '../client';
import { BudgetExceededError, getBudgetStatus, recordUsage } from './budget';
import { costUsdCentsForTurn } from './pricing';
import { buildAssistantSystem } from './system-prompt';
import { buildToolsParam } from './tools/registry';
import { getAnthropicServerTools } from './server-tools';
import type { AssistantContext, ToolRegistry } from './types';
import { DEFAULT_ASSISTANT_MAX_TOKENS } from './types';

const DEFAULT_MAX_STEPS = 8;

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input'; id: string; inputJson: string }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean }
  | {
      type: 'assistant_message_complete';
      content: Anthropic.ContentBlock[];
      stopReason: string | null;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        costCents: number;
      };
    }
  | { type: 'turn_complete'; totalCostCents: number }
  | { type: 'error'; message: string };

export type StreamTurnInput = {
  ctx: AssistantContext;
  tools: ToolRegistry;
  history: Anthropic.MessageParam[];
  userText: string;
  companyName: string;
  userFirstName?: string | null;
  planTier: string;
  maxSteps?: number;
  /**
   * Optional surface-specific system addendum (e.g., compact-chat
   * formatting rules for the Discover floating widget). Threads
   * through to buildAssistantSystem.
   */
  surfaceContext?: string;
};

/**
 * Streaming variant of the agent loop. Yields StreamEvents that a caller
 * can forward to a client via SSE. Tool dispatch happens between stream
 * iterations — tool_use events are emitted as the model plans them, then
 * tools run server-side and their results are appended to the next model
 * call.
 *
 * Budget is checked once at the start. Usage is recorded per model call,
 * not per delta.
 */
export async function* streamAgentTurn(
  input: StreamTurnInput,
): AsyncGenerator<StreamEvent, void, void> {
  try {
    const budget = await getBudgetStatus(input.ctx.companyId);
    if (budget.exceeded) throw new BudgetExceededError(budget);

    const client = getClient();
    const system = buildAssistantSystem({
      companyName: input.companyName,
      userFirstName: input.userFirstName,
      planTier: input.planTier,
      pageContext: input.ctx.pageContext,
      surfaceContext: input.surfaceContext,
    });
    const toolParams: Anthropic.Messages.ToolUnion[] = [
      ...buildToolsParam(input.tools),
      ...getAnthropicServerTools(),
    ];

    const messages: Anthropic.MessageParam[] = [
      ...input.history,
      { role: 'user', content: input.userText },
    ];

    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    let totalCostCents = 0;

    for (let step = 0; step < maxSteps; step += 1) {
      const stream = client.messages.stream({
        model: MODELS.sonnet,
        max_tokens: DEFAULT_ASSISTANT_MAX_TOKENS,
        system,
        tools: toolParams,
        messages,
      });

      // Track partial tool inputs (streamed as input_json_delta) so we can
      // emit a single reconstructed JSON payload to the client. The final
      // assistant message (from finalMessage()) has the parsed input.
      const partialToolInputs = new Map<string, { name: string; buffer: string }>();

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            partialToolInputs.set(block.id, { name: block.name, buffer: '' });
            yield { type: 'tool_use_start', id: block.id, name: block.name };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            // Tool input streams in as partial JSON fragments. We only
            // forward a single complete payload on content_block_stop.
            // Record which block id this belongs to via the tracked index.
            // The stream event doesn't directly include id here; we rely on
            // the currently-open tool_use block being the last started one.
            const last = lastEntry(partialToolInputs);
            if (last) last[1].buffer += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          // No-op; we emit tool_use_input once we see the final message so
          // we have guaranteed-parsed JSON.
        }
      }

      const final = await stream.finalMessage();

      const costCents = costUsdCentsForTurn(MODELS.sonnet, {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      });
      totalCostCents += costCents;

      await recordUsage({
        companyId: input.ctx.companyId,
        source: 'assistant',
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        costUsdCents: costCents,
      });

      // Emit any tool_use inputs now that we have guaranteed-parsed JSON.
      for (const block of final.content) {
        if (block.type === 'tool_use') {
          yield {
            type: 'tool_use_input',
            id: block.id,
            inputJson: JSON.stringify(block.input),
          };
        }
      }

      yield {
        type: 'assistant_message_complete',
        content: final.content,
        stopReason: final.stop_reason,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
          cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
          costCents,
        },
      };

      messages.push({ role: 'assistant', content: final.content });

      if (final.stop_reason !== 'tool_use') {
        yield { type: 'turn_complete', totalCostCents };
        return;
      }

      // Dispatch tool_use blocks.
      const toolUses = final.content.filter(
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
          yield {
            type: 'tool_result',
            id: use.id,
            name: use.name,
            output: { error: 'unknown_tool' },
            isError: true,
          };
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
          yield { type: 'tool_result', id: use.id, name: use.name, output, isError: false };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Tool error: ${msg}`,
            is_error: true,
          });
          yield {
            type: 'tool_result',
            id: use.id,
            name: use.name,
            output: { error: msg },
            isError: true,
          };
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error(`Agent loop exceeded ${input.maxSteps ?? DEFAULT_MAX_STEPS} steps`);
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function lastEntry<K, V>(m: Map<K, V>): [K, V] | null {
  let last: [K, V] | null = null;
  for (const entry of m) last = entry;
  return last;
}
