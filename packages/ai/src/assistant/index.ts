export { runAgentTurn, type TurnInput, type TurnResult, type TurnStep } from './loop';
export { streamAgentTurn, type StreamEvent, type StreamTurnInput } from './stream';
export {
  getBudgetStatus,
  recordUsage,
  MONTHLY_BUDGET_CENTS,
  BudgetExceededError,
  type BudgetStatus,
  type UsageSource,
  type PlanTier,
  type RecordUsageInput,
} from './budget';
export { costUsdCentsForTurn, costUsdCentsForEmbedding } from './pricing';
export { meter, meterEmbedding } from './meter';
export { buildAssistantSystem } from './system-prompt';
export { defineTool, buildToolsParam, zodToJsonSchema } from './tools/registry';
export {
  logToolCall,
  withToolTelemetry,
  type LogToolCallInput,
  type ToolTelemetrySummary,
} from './tool-telemetry';

// Re-export commonly-needed Anthropic types so downstream packages can stay
// on a single SDK version without adding a direct dependency.
import type Anthropic from '@anthropic-ai/sdk';
export type AnthropicMessageParam = Anthropic.MessageParam;
export type AnthropicContentBlock = Anthropic.ContentBlock;
export type AnthropicTextBlockParam = Anthropic.TextBlockParam;
export type AnthropicImageBlockParam = Anthropic.ImageBlockParam;
export type AnthropicDocumentBlockParam = Anthropic.DocumentBlockParam;
export type AnthropicToolUseBlock = Anthropic.ToolUseBlock;
export type AnthropicToolResultBlockParam = Anthropic.ToolResultBlockParam;
export type {
  AssistantContext,
  PageContext,
  ToolDefinition,
  AnyToolDefinition,
  ToolRegistry,
} from './types';
