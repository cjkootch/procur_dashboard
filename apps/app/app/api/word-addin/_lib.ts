import 'server-only';
import { resolveWordAddinToken } from '../../../lib/word-addin-tokens';

/**
 * Extract a Bearer token from the request and resolve it. Returns null
 * on any failure path (missing header, malformed header, unknown
 * token, revoked token). Callers should respond 401 in that case
 * without distinguishing the failure mode — same UX pattern as Stripe /
 * GitHub PAT.
 */
export async function authenticateWordAddinRequest(req: Request): Promise<{
  companyId: string;
  userId: string;
  tokenId: string;
} | null> {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/);
  if (!match) return null;
  return resolveWordAddinToken(match[1] ?? '');
}

export function jsonResponse<T>(payload: T, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...init?.headers,
    },
  });
}

export function unauthorized(): Response {
  return jsonResponse({ error: 'unauthorized' }, { status: 401 });
}
