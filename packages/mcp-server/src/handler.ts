import { performance } from 'node:perf_hooks';
import { eq, sql } from 'drizzle-orm';
import { db, mcpApiKeys } from '@procur/db';
import type { ToolRegistry } from '@procur/ai';
import { loadMcpConfig } from './config';
import { findActiveKeyByRaw } from './keys';
import { logMcpCall } from './call-log';
import { sharedMcpRateLimiter } from './rate-limiter';
import { callMcpTool, listMcpTools } from './adapter';
import {
  JSONRPC_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolParams,
  type McpInitializeResult,
} from './types';

/**
 * Top-level MCP request handler. Wraps Web Request/Response so the
 * Next.js Route Handler at /api/mcp is a one-line dispatch.
 *
 * Flow:
 *   1. Parse JSON-RPC envelope (single-message; batch unsupported in v1)
 *   2. Resolve API key from Authorization: Bearer
 *   3. Rate-limit check
 *   4. Dispatch by method (initialize / tools/list / tools/call)
 *   5. Log to mcp_tool_call_log
 *   6. Return JSON-RPC response
 *
 * Auth is checked even for `initialize` — MCP hosts call initialize
 * before tools/list, and we want unauthenticated probes to fail
 * fast. (The MCP spec doesn't require auth on initialize, but
 * we're tighter.)
 */

export type HandleMcpRequestArgs = {
  request: Request;
  /** The procur catalog tool registry. The handler doesn't
   *  construct it — callers (the route handler in apps/app)
   *  build it once at module scope and pass it in to avoid
   *  per-request rebuilds. */
  registry: ToolRegistry;
  serverVersion: string;
};

export async function handleMcpRequest(
  args: HandleMcpRequestArgs,
): Promise<Response> {
  const config = loadMcpConfig();

  // GET probe: hosts hit this before sending a real JSON-RPC POST.
  // Return up-check info regardless of the feature flag — flag-off
  // detection should look at the body of a GET, not a JSON-RPC error
  // (clients with strict schemas reject id=null responses).
  if (args.request.method === 'GET') {
    if (!config.enabled) {
      return new Response(
        JSON.stringify({
          protocol: 'mcp',
          version: MCP_PROTOCOL_VERSION,
          enabled: false,
          message: 'MCP integration is not enabled in this environment.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        protocol: 'mcp',
        version: MCP_PROTOCOL_VERSION,
        enabled: true,
        message: 'Send POST with JSON-RPC payload + Authorization: Bearer <key>.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (args.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Parse envelope BEFORE checking the feature flag so degrade
  // responses can echo the request's id. Strict clients (mcp-remote)
  // reject id=null responses against requests that had a numeric id.
  let body: JsonRpcRequest;
  try {
    body = (await args.request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcResponse(null, {
      error: { code: JSONRPC_ERROR.PARSE_ERROR, message: 'Invalid JSON.' },
    });
  }

  if (
    !body ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string'
  ) {
    return jsonRpcResponse(body?.id ?? null, {
      error: { code: JSONRPC_ERROR.INVALID_REQUEST, message: 'Invalid JSON-RPC request.' },
    });
  }

  const id = body.id ?? null;
  const hostIdentifier = args.request.headers.get('user-agent') ?? null;

  // Feature flag — checked after body parsing so the error response
  // carries the request's id. Same pattern as the auth + rate-limit
  // returns below.
  if (!config.enabled) {
    return jsonRpcResponse(id, {
      error: {
        code: JSONRPC_ERROR.INTERNAL_ERROR,
        message: 'MCP integration is not enabled in this environment.',
      },
    });
  }

  // Auth.
  const authHeader = args.request.headers.get('authorization') ?? '';
  const rawKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;
  if (!rawKey) {
    await logMcpCall({
      toolName: body.method,
      outcome: 'auth_failed',
      errorMessage: 'missing Authorization: Bearer',
      hostIdentifier: hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(id, {
      error: { code: JSONRPC_ERROR.AUTH_FAILED, message: 'Authorization required.' },
    });
  }

  const keyRow = await findActiveKeyByRaw(rawKey);
  if (!keyRow) {
    await logMcpCall({
      toolName: body.method,
      outcome: 'auth_failed',
      errorMessage: 'unknown or revoked key',
      hostIdentifier: hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(id, {
      error: { code: JSONRPC_ERROR.AUTH_FAILED, message: 'Invalid or revoked API key.' },
    });
  }

  // Rate limit.
  if (!sharedMcpRateLimiter.tryAcquire(keyRow.id)) {
    await logMcpCall({
      apiKeyId: keyRow.id,
      companyId: keyRow.companyId,
      toolName: body.method,
      outcome: 'rate_limited',
      errorMessage: 'per-key hourly cap exceeded',
      hostIdentifier: hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(id, {
      error: {
        code: JSONRPC_ERROR.RATE_LIMITED,
        message: 'Rate limit exceeded for this API key.',
      },
    });
  }

  // Dispatch.
  switch (body.method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        result: initializeResult(args.serverVersion),
      });

    case 'notifications/initialized':
      // Fire-and-forget notification from the client. Acknowledge
      // with empty 200 (no JSON-RPC response per spec).
      return new Response(null, { status: 202 });

    case 'tools/list':
      return jsonRpcResponse(id, {
        result: listMcpTools(args.registry),
      });

    case 'tools/call':
      return handleToolsCall({
        id,
        params: (body.params ?? {}) as McpCallToolParams,
        registry: args.registry,
        keyRow,
        hostIdentifier,
      });

    case 'ping':
      return jsonRpcResponse(id, { result: {} });

    default:
      await logMcpCall({
        apiKeyId: keyRow.id,
        companyId: keyRow.companyId,
        toolName: body.method,
        outcome: 'invalid_input',
        errorMessage: 'unknown method',
        hostIdentifier: hostIdentifier ?? undefined,
      });
      return jsonRpcResponse(id, {
        error: {
          code: JSONRPC_ERROR.METHOD_NOT_FOUND,
          message: `Method not supported: ${body.method}`,
        },
      });
  }
}

async function handleToolsCall(args: {
  id: number | string | null;
  params: McpCallToolParams;
  registry: ToolRegistry;
  keyRow: { id: string; companyId: string; createdByUserId: string };
  hostIdentifier: string | null;
}): Promise<Response> {
  const started = performance.now();
  const toolName = typeof args.params.name === 'string' ? args.params.name : '';
  if (!toolName) {
    return jsonRpcResponse(args.id, {
      error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: 'Missing tool name.' },
    });
  }

  const result = await callMcpTool({
    registry: args.registry,
    name: toolName,
    args: (args.params.arguments ?? {}) as Record<string, unknown>,
    context: {
      companyId: args.keyRow.companyId,
      userId: args.keyRow.createdByUserId,
    },
  });

  const durationMs = Math.round(performance.now() - started);

  if ('error' in result) {
    // Differentiate "not whitelisted" from "handler threw"; the
    // adapter signals not-whitelisted in the message.
    const notWhitelisted = result.error.message.startsWith('tool not found');
    await logMcpCall({
      apiKeyId: args.keyRow.id,
      companyId: args.keyRow.companyId,
      toolName,
      outcome: notWhitelisted ? 'tool_not_whitelisted' : 'tool_error',
      durationMs,
      errorMessage: result.error.message,
      hostIdentifier: args.hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(args.id, {
      error: {
        code: notWhitelisted
          ? JSONRPC_ERROR.TOOL_NOT_WHITELISTED
          : JSONRPC_ERROR.TOOL_HANDLER_ERROR,
        message: notWhitelisted
          ? `Tool not exposed via MCP: ${toolName}`
          : 'Tool handler failed.',
      },
    });
  }

  // Bump the key's usage counters. Best-effort; doesn't block response.
  await db
    .update(mcpApiKeys)
    .set({
      lastUsedAt: new Date(),
      totalCalls: sql`${mcpApiKeys.totalCalls} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(mcpApiKeys.id, args.keyRow.id));

  await logMcpCall({
    apiKeyId: args.keyRow.id,
    companyId: args.keyRow.companyId,
    toolName,
    outcome: result.result.isError ? 'invalid_input' : 'success',
    durationMs,
    hostIdentifier: args.hostIdentifier ?? undefined,
  });

  return jsonRpcResponse(args.id, { result: result.result });
}

function initializeResult(version: string): McpInitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'procur', version },
  };
}

function jsonRpcResponse(
  id: number | string | null,
  body:
    | { result: unknown }
    | { error: JsonRpcError },
): Response {
  const payload: JsonRpcResponse =
    'result' in body
      ? { jsonrpc: '2.0', id, result: body.result }
      : { jsonrpc: '2.0', id, error: body.error };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
