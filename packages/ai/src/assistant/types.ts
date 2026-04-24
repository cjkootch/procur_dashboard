import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

/** Invariant context every tool handler receives. Never populated from user input. */
export type AssistantContext = {
  companyId: string;
  userId: string;
  /** Optional: the page the assistant was invoked from (e.g. { kind: 'pursuit', id }). */
  pageContext?: PageContext;
};

export type PageContext =
  | { kind: 'pursuit'; id: string }
  | { kind: 'proposal'; id: string }
  | { kind: 'opportunity'; id: string }
  | { kind: 'contract'; id: string };

/**
 * A tool definition. The handler is always called server-side with the
 * auth-scoped context, never with a raw companyId from the model.
 *
 * Write tools follow a propose-then-apply pattern: the handler returns
 * a preview the UI renders as a confirmation card. Applying the
 * proposal is a separate user-initiated action.
 */
export type ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> = {
  name: string;
  description: string;
  schema: I;
  jsonSchema: Anthropic.Tool['input_schema'];
  kind: 'read' | 'write';
  handler: (ctx: AssistantContext, input: z.infer<I>) => Promise<O>;
};

/**
 * Runtime-shaped tool registry. We deliberately use `any` for the schema
 * generic so concrete tools with narrow zod types stay assignable. All
 * consumer-facing invariants (name/description/kind/jsonSchema) remain
 * strictly typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;
export type ToolRegistry = Record<string, AnyToolDefinition>;
