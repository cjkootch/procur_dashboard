import { NextResponse } from 'next/server';
import { requireUser } from '@procur/auth';
import { runMpiApolloEnrichment } from '@procur/apollo';

/**
 * One-shot remote trigger for Apollo enrichment of USDA FSIS MPI
 * establishments.
 *
 * Sibling of /api/admin/seed/usda-fsis-mpi — same auth pattern. Use
 * after the MPI seed has populated the establishments table; this
 * walks pending rows (apollo_synced_at IS NULL) and matches each by
 * legal_name + state via Apollo's mixed_companies/search, writing
 * back primary_domain + website_url + apollo_org_id.
 *
 * Scope is bounded per call so Vercel maxDuration doesn't trip on
 * larger batches. Pass `{ "limit": N }` in the body to override
 * (default 200). Returns `remaining` so the operator can poll
 * until done.
 *
 * Body shape (optional):
 *   {
 *     "limit": 200,             // rows per run
 *     "staleHours": 720,        // refresh rows older than this
 *     "speciesFilter": "swine"  // process pork-relevant rows first
 *   }
 *
 * Returns:
 *   { ok, elapsedMs, processed, matched, unmatched, errors,
 *     remaining, apolloCalls }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RequestBody {
  limit?: number;
  staleHours?: number;
  speciesFilter?: string;
}

export async function POST(req: Request): Promise<Response> {
  const adminEmail = process.env.ADMIN_SEED_OPERATOR_EMAIL;
  if (!adminEmail) {
    return NextResponse.json(
      {
        error: 'admin_seed_disabled',
        message:
          'ADMIN_SEED_OPERATOR_EMAIL env var is not set. Set it in Vercel to enable this route.',
      },
      { status: 503 },
    );
  }

  const user = await requireUser();
  if (user.email.toLowerCase() !== adminEmail.toLowerCase()) {
    return NextResponse.json(
      { error: 'forbidden', message: 'admin only' },
      { status: 403 },
    );
  }

  let body: RequestBody = {};
  try {
    body = ((await req.json()) as RequestBody) ?? {};
  } catch {
    // No body — fine.
  }

  try {
    const startedAt = Date.now();
    const result = await runMpiApolloEnrichment({
      ...(body.limit != null ? { limit: body.limit } : {}),
      ...(body.staleHours != null ? { staleHours: body.staleHours } : {}),
      ...(body.speciesFilter ? { speciesFilter: body.speciesFilter } : {}),
    });
    const elapsedMs = Date.now() - startedAt;
    return NextResponse.json({
      ok: true,
      elapsedMs,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'enrichment_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    description:
      'POST this route to trigger Apollo enrichment for pending USDA FSIS MPI establishments. Optional body: { "limit": 200, "staleHours": 720, "speciesFilter": "swine" }. Auth-gated to ADMIN_SEED_OPERATOR_EMAIL. Single call processes UP TO `limit` rows; re-POST until `remaining` is 0.',
  });
}
