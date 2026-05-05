import { handleMcpRequest } from '@procur/mcp-server';
import { buildCatalogTools } from '@procur/catalog/tools';

/**
 * MCP server endpoint per docs/mcp-server-brief.md §3.1.
 *
 * Wire format: JSON-RPC 2.0 over HTTP. Authentication: Bearer
 * <procur_mcp_…> from a key generated at /settings/integrations/mcp.
 *
 * The catalog tool registry is constructed once at module-scope and
 * reused across requests so the per-request work is pure dispatch.
 */
export const dynamic = 'force-dynamic';

const REGISTRY = buildCatalogTools();
const SERVER_VERSION = '0.0.0';

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest({
    request,
    registry: REGISTRY,
    serverVersion: SERVER_VERSION,
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest({
    request,
    registry: REGISTRY,
    serverVersion: SERVER_VERSION,
  });
}
