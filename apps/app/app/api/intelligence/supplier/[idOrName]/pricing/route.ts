import { NextResponse } from 'next/server';
import { z } from 'zod';
import { analyzeSupplier, analyzeSupplierPricing } from '@procur/catalog';
import { verifyIntelligenceToken } from '../../../../../../lib/intelligence-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/intelligence/supplier/[idOrName]/pricing
 *   ?minConfidence=0.6&daysBack=1095
 *
 * Wraps `analyzeSupplierPricing`. The query expects a supplierId; if a
 * name was passed in the path we resolve it via `analyzeSupplier` first
 * (which can return disambiguation candidates — surfaced unchanged).
 */
const QuerySchema = z.object({
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  daysBack: z.coerce.number().int().min(1).max(3650).optional(),
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
    minConfidence: url.searchParams.get('minConfidence') ?? undefined,
    daysBack: url.searchParams.get('daysBack') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let supplierId = idOrName;
  if (!UUID_RE.test(idOrName)) {
    const resolved = await analyzeSupplier({
      supplierName: decodeURIComponent(idOrName),
    });
    if (resolved.kind === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (resolved.kind === 'disambiguation_needed') {
      return NextResponse.json(resolved, { status: 409 });
    }
    supplierId = resolved.supplier.id;
  }

  const profile = await analyzeSupplierPricing({
    supplierId,
    minConfidence: parsed.data.minConfidence,
    daysBack: parsed.data.daysBack,
  });
  return NextResponse.json(profile);
}
