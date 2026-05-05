import { performance } from 'node:perf_hooks';
import { eq, sql } from 'drizzle-orm';
import { db, mcpApiKeys } from '@procur/db';
import { loadMcpConfig } from './config';
import { findActiveKeyByRaw } from './keys';
import { logMcpCall } from './call-log';
import { sharedMcpRateLimiter } from './rate-limiter';
import {
  JSONRPC_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolParams,
  type McpInitializeResult,
  type McpListToolsResult,
} from './types';

/**
 * Specialized MCP endpoint for ChatGPT custom GPTs / OpenAI Deep
 * Research, which require the EXACT search+fetch tool shape — not
 * arbitrary catalog tool names. Spec mismatches procur's general
 * MCP endpoint enough that it gets its own handler.
 *
 * Per the OpenAI Deep Research / Custom GPT MCP contract:
 *   - search(query: string) -> { results: [{ id, title, url }] }
 *   - fetch(id: string)      -> { id, title, text, url, metadata? }
 *
 * IDs returned by search must be opaque-to-the-client but stable
 * enough that fetch can resolve them. We prefix with the resource
 * type ("entity:<slug>") so future expansion (awards, commodities,
 * etc.) stays unambiguous.
 *
 * Auth + rate limit + log discipline are identical to the general
 * /api/mcp handler. Same per-tenant API keys; same mcp_tool_call_log
 * rows. The whitelist concept doesn't apply — only search + fetch
 * are ever exposed here.
 */

export type ChatgptSearchResult = {
  id: string;
  title: string;
  url: string;
};

export type ChatgptFetchResult = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, unknown>;
};

export type ChatgptSearchProvider = (args: {
  query: string;
  companyId: string;
}) => Promise<ChatgptSearchResult[]>;

export type ChatgptFetchProvider = (args: {
  id: string;
  companyId: string;
}) => Promise<ChatgptFetchResult | null>;

export type HandleChatgptMcpRequestArgs = {
  request: Request;
  /** Resolves a free-text query to candidate procur resources. */
  search: ChatgptSearchProvider;
  /** Resolves an ID returned by search to full content. */
  fetch: ChatgptFetchProvider;
  serverVersion: string;
};

export async function handleChatgptMcpRequest(
  args: HandleChatgptMcpRequestArgs,
): Promise<Response> {
  const config = loadMcpConfig();

  if (args.request.method === 'GET') {
    if (!config.enabled) {
      return new Response(
        JSON.stringify({
          protocol: 'mcp',
          variant: 'chatgpt-search-fetch',
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
        variant: 'chatgpt-search-fetch',
        version: MCP_PROTOCOL_VERSION,
        enabled: true,
        tools: ['search', 'fetch'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (args.request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Parse envelope BEFORE the feature-flag check so degrade responses
  // carry the request's id. Strict clients reject id=null responses
  // against requests that had a numeric id.
  let body: JsonRpcRequest;
  try {
    body = (await args.request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcResponse(null, {
      error: { code: JSONRPC_ERROR.PARSE_ERROR, message: 'Invalid JSON.' },
    });
  }

  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonRpcResponse(body?.id ?? null, {
      error: { code: JSONRPC_ERROR.INVALID_REQUEST, message: 'Invalid JSON-RPC request.' },
    });
  }

  const id = body.id ?? null;
  const hostIdentifier = args.request.headers.get('user-agent') ?? null;

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

  switch (body.method) {
    case 'initialize':
      return jsonRpcResponse(id, { result: initializeResult(args.serverVersion) });

    case 'notifications/initialized':
      return new Response(null, { status: 202 });

    case 'tools/list':
      return jsonRpcResponse(id, { result: listChatgptTools() });

    case 'tools/call':
      return handleChatgptToolsCall({
        id,
        params: (body.params ?? {}) as McpCallToolParams,
        keyRow,
        hostIdentifier,
        search: args.search,
        fetch: args.fetch,
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

function listChatgptTools(): McpListToolsResult {
  return {
    tools: [
      {
        name: 'search',
        description:
          "Search procur's curated rolodex of buyers, sellers, traders, refiners, " +
          'and producers by name. Returns a list of candidate resources with stable ' +
          'IDs. Pass a returned ID to `fetch` to get the full entity profile.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query — name, alias, or partial match.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'fetch',
        description:
          'Fetch full content for a procur resource by ID returned from `search`. ' +
          'Returns the entity profile including identity, role, geographic location, ' +
          'aliases, categories, and analyst notes.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Resource ID returned by `search` (e.g. "entity:apollo").',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ],
  };
}

async function handleChatgptToolsCall(args: {
  id: number | string | null;
  params: McpCallToolParams;
  keyRow: { id: string; companyId: string; createdByUserId: string };
  hostIdentifier: string | null;
  search: ChatgptSearchProvider;
  fetch: ChatgptFetchProvider;
}): Promise<Response> {
  const started = performance.now();
  const toolName = typeof args.params.name === 'string' ? args.params.name : '';
  const toolArgs = (args.params.arguments ?? {}) as Record<string, unknown>;

  if (toolName !== 'search' && toolName !== 'fetch') {
    await logMcpCall({
      apiKeyId: args.keyRow.id,
      companyId: args.keyRow.companyId,
      toolName,
      outcome: 'tool_not_whitelisted',
      durationMs: Math.round(performance.now() - started),
      errorMessage: 'chatgpt endpoint exposes only search + fetch',
      hostIdentifier: args.hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(args.id, {
      error: {
        code: JSONRPC_ERROR.TOOL_NOT_WHITELISTED,
        message: 'ChatGPT MCP endpoint exposes only `search` and `fetch`.',
      },
    });
  }

  try {
    let payload: unknown;
    if (toolName === 'search') {
      const query = typeof toolArgs.query === 'string' ? toolArgs.query.trim() : '';
      if (!query) {
        return jsonRpcResponse(args.id, {
          error: {
            code: JSONRPC_ERROR.INVALID_PARAMS,
            message: 'Missing or empty `query`.',
          },
        });
      }
      const results = await args.search({ query, companyId: args.keyRow.companyId });
      payload = { results };
    } else {
      const id = typeof toolArgs.id === 'string' ? toolArgs.id.trim() : '';
      if (!id) {
        return jsonRpcResponse(args.id, {
          error: {
            code: JSONRPC_ERROR.INVALID_PARAMS,
            message: 'Missing or empty `id`.',
          },
        });
      }
      const result = await args.fetch({ id, companyId: args.keyRow.companyId });
      if (!result) {
        return jsonRpcResponse(args.id, {
          result: {
            content: [
              { type: 'text', text: `No procur resource found for id: ${id}` },
            ],
            isError: true,
          },
        });
      }
      payload = result;
    }

    const durationMs = Math.round(performance.now() - started);
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
      outcome: 'success',
      durationMs,
      hostIdentifier: args.hostIdentifier ?? undefined,
    });

    return jsonRpcResponse(args.id, {
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    await logMcpCall({
      apiKeyId: args.keyRow.id,
      companyId: args.keyRow.companyId,
      toolName,
      outcome: 'tool_error',
      durationMs,
      errorMessage: err instanceof Error ? err.message : String(err),
      hostIdentifier: args.hostIdentifier ?? undefined,
    });
    return jsonRpcResponse(args.id, {
      error: {
        code: JSONRPC_ERROR.TOOL_HANDLER_ERROR,
        message: 'Tool handler failed.',
      },
    });
  }
}

function initializeResult(version: string): McpInitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'procur (ChatGPT search+fetch)', version },
  };
}

function jsonRpcResponse(
  id: number | string | null,
  body: { result: unknown } | { error: JsonRpcError },
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
