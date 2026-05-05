import type { ToolRegistry, AssistantContext } from '@procur/ai';

type AnyToolDefinition = ToolRegistry[string];
import { MCP_TOOL_WHITELIST_SET } from './whitelist';
import type {
  McpCallToolResult,
  McpListToolsResult,
  McpToolDescriptor,
} from './types';

/**
 * Adapter from procur's defineTool registry to MCP wire-protocol
 * tool descriptors. Filters by the whitelist + by tool kind
 * (only `read` tools — write tools are excluded as a defense-in-
 * depth check beyond the whitelist).
 *
 * Tools listed in the whitelist that don't exist in the registry
 * (e.g. Apollo tools before Apollo Day 6 lands) are silently
 * skipped. Tools in the registry that aren't whitelisted are also
 * silently skipped — the catalog package can grow without
 * inadvertently exposing new tools over MCP.
 */
export function listMcpTools(registry: ToolRegistry): McpListToolsResult {
  const tools: McpToolDescriptor[] = [];
  for (const tool of Object.values(registry)) {
    if (!MCP_TOOL_WHITELIST_SET.has(tool.name)) continue;
    if (tool.kind !== 'read') continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema as Record<string, unknown>,
    });
  }
  // Stable sort for deterministic listing across hosts.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools };
}

/**
 * Find a whitelisted tool by name. Returns null when the tool
 * doesn't exist OR isn't whitelisted OR isn't read-kind. Callers
 * map null to the TOOL_NOT_WHITELISTED error code.
 */
export function findWhitelistedTool(
  registry: ToolRegistry,
  name: string,
): AnyToolDefinition | null {
  if (!MCP_TOOL_WHITELIST_SET.has(name)) return null;
  const tool = registry[name];
  if (!tool) return null;
  if (tool.kind !== 'read') return null;
  return tool;
}

export type CallToolArgs = {
  registry: ToolRegistry;
  name: string;
  args: Record<string, unknown>;
  context: AssistantContext;
};

/**
 * Dispatch a tool call against the whitelisted registry. Returns
 * an MCP-shaped CallToolResult. Validation errors and handler
 * errors are wrapped as `isError: true` text content rather than
 * thrown — MCP clients handle isError-flagged results as user-
 * surfacable feedback rather than transport failures.
 *
 * The thrown / unknown error path returns null so the request
 * handler can map it to a JSON-RPC TOOL_HANDLER_ERROR with a
 * generic message — keeping internal exception details out of the
 * client response.
 */
export async function callMcpTool(
  args: CallToolArgs,
): Promise<{ result: McpCallToolResult } | { error: { message: string } }> {
  const tool = findWhitelistedTool(args.registry, args.name);
  if (!tool) {
    return { error: { message: `tool not found or not whitelisted: ${args.name}` } };
  }

  // Zod validation. Failures land as isError text content so the
  // calling LLM can read and correct.
  const parsed = tool.schema.safeParse(args.args ?? {});
  if (!parsed.success) {
    return {
      result: {
        content: [
          {
            type: 'text',
            text: `Invalid arguments for ${args.name}:\n${parsed.error.message}`,
          },
        ],
        isError: true,
      },
    };
  }

  try {
    const output = await tool.handler(args.context, parsed.data);
    const text =
      typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return {
      result: {
        content: [{ type: 'text', text }],
      },
    };
  } catch (err) {
    // Don't leak the underlying error message — could surface
    // SQL fragments, internal IDs, etc. The caller logs a fuller
    // form via mcp_tool_call_log.
    return {
      error: {
        message: err instanceof Error ? err.message : 'tool handler failed',
      },
    };
  }
}
