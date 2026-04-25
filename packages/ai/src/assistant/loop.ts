import type Anthropic from '@anthropic-ai/sdk';
import { getClient, MODELS } from '../client';
import { BudgetExceededError, getBudgetStatus, recordUsage } from './budget';
import { costUsdCentsForTurn } from './pricing';
import { buildAssistantSystem } from './system-prompt';
import { buildToolsParam } from './tools/registry';
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
  const toolParams = buildToolsParam(input.tools);

  const messages: Anthropic.MessageParam[] = [
    ...input.history,
    { role: 'user', content: input.userText },
  ];

  const steps: TurnStep[] = [];
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  let totalCostCents = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await client.messages.create({
      model: MODELS.sonnet,
      max_tokens: DEFAULT_ASSISTANT_MAX_TOKENS,
      system,
      tools: toolParams,
      messages,
    });

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
