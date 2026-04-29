import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeSupplier } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/supplier/[idOrName]
 *   ?yearsLookback=10
 *
 * Wraps `analyzeSupplier`. The path param is treated as a UUID first; if
 * that lookup misses we fall back to fuzzy-name resolution. May return
 * { kind: 'disambiguation_needed', candidates: [...] } when the name
 * resolves to multiple suppliers — the caller picks one and re-queries
 * with that supplierId.
 */
const QuerySchema = z.object({
  yearsLookback: z.coerce.number().int().min(1).max(50).optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ idOrName: string }> },
): Promise<Response> {
  const auth = verifyIntelligenceToken(req);
  if (auth) return auth;

  const { idOrName } = await params;
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    yearsLookback: url.searchParams.get('yearsLookback') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const args = UUID_RE.test(idOrName)
    ? { supplierId: idOrName, yearsLookback: parsed.data.yearsLookback }
    : { supplierName: decodeURIComponent(idOrName), yearsLookback: parsed.data.yearsLookback };

  const result = await analyzeSupplier(args);
  return NextResponse.json(result);
}
