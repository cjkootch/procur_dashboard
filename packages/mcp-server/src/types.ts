/**
 * MCP wire-protocol types. We implement the JSON-RPC 2.0 envelope
 * directly rather than depending on @modelcontextprotocol/sdk —
 * the procur surface is tools-only with non-streaming responses,
 * which the SDK's StreamableHTTPServerTransport over-engineers
 * for our case (its req/res shape doesn't match Next.js Route
 * Handler's Web Request/Response).
 *
 * Spec: https://spec.modelcontextprotocol.io
 * Wire format: JSON-RPC 2.0 (https://www.jsonrpc.org/specification).
 */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | {
      jsonrpc: '2.0';
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: '2.0';
      id: JsonRpcId;
      error: JsonRpcError;
    };

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** Standard JSON-RPC error codes. */
export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Custom range. We use these for procur-specific failures. */
  AUTH_FAILED: -32001,
  RATE_LIMITED: -32002,
  TOOL_NOT_WHITELISTED: -32003,
  TOOL_HANDLER_ERROR: -32004,
} as const;

// ─── MCP-specific shapes ─────────────────────────────────────────

/** Latest stable protocol version we support. Returned in
 *  initialize result. */
export const MCP_PROTOCOL_VERSION = '2025-06-18' as const;

export type McpInitializeParams = {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: {
    name: string;
    version?: string;
  };
};

export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpListToolsResult = {
  tools: McpToolDescriptor[];
};

export type McpCallToolParams = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'json'; json: unknown };

export type McpCallToolResult = {
  content: McpToolContent[];
  isError?: boolean;
};
