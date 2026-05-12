import { NextResponse } from 'next/server';
import { requireUser } from '@procur/auth';
import { runMpiIntelligencePipeline } from '@procur/ai';

/**
 * One-shot remote trigger for the USDA FSIS MPI → rolodex +
 * website-intelligence pipeline. Sibling of:
 *   - /api/admin/seed/usda-fsis-mpi  (PR #657 — base ingest)
 *   - /api/admin/enrich/usda-fsis-apollo  (PR #659 — Apollo thin enrichment)
 *
 * This route consumes the Apollo enrichment output: for each MPI row
 * with `primary_domain` set, promotes the establishment to a shadow
 * `known_entities` rolodex row, then fires the existing
 * `crawl-entity-website` Sonnet pipeline on that slug. The crawl
 * extracts `entity_web_summaries` covering product/cut/operations
 * detail — which is what surfaces in chat's `analyze_supplier` tool
 * for the operator's scale/capacity/cuts question.
 *
 * Crawl is expensive (~30-60s + LLM cost per entity). Default
 * `limit=25` keeps each Vercel-route call comfortably under the 300s
 * ceiling. Operator polls until `remaining == 0`.
 *
 * Body shape (optional):
 *   {
 *     "limit": 25,
 *     "crawl": true,             // set false for fast promotion-only pass
 *     "speciesFilter": "swine"
 *   }
 *
 * Returns:
 *   { ok, elapsedMs, processed, promoted, crawled, crawlErrors,
 *     errors, remaining }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RequestBody {
  limit?: number;
  crawl?: boolean;
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
    const result = await runMpiIntelligencePipeline({
      ...(body.limit != null ? { limit: body.limit } : {}),
      ...(body.crawl != null ? { crawl: body.crawl } : {}),
      ...(body.speciesFilter ? { speciesFilter: body.speciesFilter } : {}),
    });
    const elapsedMs = Date.now() - startedAt;
    return NextResponse.json({ ok: true, elapsedMs, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: 'intel_pipeline_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json({
    description:
      'POST this route to promote USDA FSIS MPI establishments (with Apollo-resolved primary_domain) into the rolodex and fire the existing crawl-entity-website Sonnet pipeline. Optional body: { "limit": 25, "crawl": true, "speciesFilter": "swine" }. Auth-gated to ADMIN_SEED_OPERATOR_EMAIL. Single call processes UP TO `limit` rows; re-POST until `remaining` is 0.',
  });
}
