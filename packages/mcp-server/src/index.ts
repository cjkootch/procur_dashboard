/**
 * @procur/mcp-server — Apollo / Claude Desktop / ChatGPT / Cursor
 * tool surface over the Model Context Protocol.
 *
 * Day 1 (this PR): schema + key management + rate limiter +
 * call-log helper. No HTTP transport yet; importing the package
 * is safe and accepts no external traffic until Day 2 ships.
 *
 * Day 2: Streamable HTTP route handler at /api/mcp + tool-shape
 * adapter that re-exposes the curated whitelist from
 * @procur/catalog/tools.
 *
 * Spec: docs/mcp-server-brief.md.
 */

export {
  MCP_KEY_PREFIX,
  MCP_KEY_RAW_LENGTH,
  MCP_RATE_LIMIT_PER_HOUR,
  MCP_DISPLAY_SUFFIX_LENGTH,
  loadMcpConfig,
  type McpConfig,
} from './config';

export {
  generateRawKey,
  hashKey,
  deriveDisplaySuffix,
  createMcpApiKey,
  findActiveKeyByRaw,
  listMcpKeysForCompany,
  revokeMcpApiKey,
  type CreateMcpApiKeyArgs,
  type CreateMcpApiKeyResult,
} from './keys';

export { logMcpCall, type LogMcpCallArgs } from './call-log';

export {
  McpRateLimiter,
  sharedMcpRateLimiter,
} from './rate-limiter';

export {
  handleMcpRequest,
  type HandleMcpRequestArgs,
} from './handler';

export {
  handleChatgptMcpRequest,
  type HandleChatgptMcpRequestArgs,
  type ChatgptSearchProvider,
  type ChatgptFetchProvider,
  type ChatgptSearchResult,
  type ChatgptFetchResult,
} from './chatgpt-handler';

export {
  listMcpTools,
  findWhitelistedTool,
  callMcpTool,
} from './adapter';

export {
  MCP_TOOL_WHITELIST,
  MCP_TOOL_WHITELIST_SET,
} from './whitelist';

export {
  MCP_PROTOCOL_VERSION,
  JSONRPC_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpToolDescriptor,
  type McpToolContent,
} from './types';
