import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service bearer token verification for the
 * `/api/intelligence/*` surface.
 *
 * The token lives in `VEX_API_TOKEN` (set on Vercel for the project).
 * Vex sends it as `Authorization: Bearer <token>`. We do a constant-time
 * comparison so token-length leaks aren't observable to a malicious
 * caller.
 *
 * Returns `null` when the token is valid → caller proceeds with the
 * handler. Returns a `NextResponse` (401 / 500) when invalid → caller
 * returns it directly.
 */
export function verifyIntelligenceToken(req: Request): NextResponse | null {
  const expected = process.env.VEX_API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'service_unavailable', detail: 'VEX_API_TOKEN not configured' },
      { status: 500 },
    );
  }

  const header = req.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json(
      { error: 'unauthorized', detail: 'Missing Bearer token' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  const presented = header.slice('bearer '.length).trim();
  if (!constantTimeEqual(presented, expected)) {
    return NextResponse.json(
      { error: 'unauthorized', detail: 'Invalid token' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. Pad both sides to the
  // longer length first so length differences don't short-circuit.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  return timingSafeEqual(aPad, bPad) && aBuf.length === bBuf.length;
}
