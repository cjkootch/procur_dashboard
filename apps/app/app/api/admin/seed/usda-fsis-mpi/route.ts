import { NextResponse } from 'next/server';
import { requireUser } from '@procur/auth';
import { runMpiDirectoryIngest } from '@procur/db/ingest-usda-fsis-mpi-lib';

/**
 * One-shot remote trigger for the USDA FSIS MPI Directory ingest.
 *
 * Use case: operator is away from desk but wants to seed the
 * usda_fsis_establishments table after this PR lands. They hit this
 * route from their phone; the Vercel function runs the same library
 * fn the CLI uses, against the production DATABASE_URL.
 *
 * Auth: gated to ADMIN_SEED_OPERATOR_EMAIL (set in Vercel env). When
 * the env var is absent, the route refuses entirely — better closed
 * by default than open to anyone with a procur login.
 *
 * Vercel maxDuration: 300s (5 min). ~6,000 rows in the MPI Directory
 * × 500-row batches = ~12 batches. Each batch is a single multi-VALUES
 * INSERT to Neon HTTP — total runtime typically 5-15 seconds. The 5
 * minute ceiling is generous overhead for FSIS CSV download + parsing.
 *
 * Idempotent: re-running upserts on establishment_number; never
 * resets enrichment columns.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

  let explicitCsvUrl: string | undefined;
  try {
    const body = (await req.json()) as { csvUrl?: string } | null;
    if (body?.csvUrl) explicitCsvUrl = body.csvUrl;
  } catch {
    // No body — fine; we'll auto-discover.
  }

  try {
    const startedAt = Date.now();
    const result = await runMpiDirectoryIngest(explicitCsvUrl);
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
        error: 'ingest_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  // Helpful one-liner so operators hitting the URL in a browser see
  // what's available rather than a generic 405.
  return NextResponse.json({
    description:
      'POST this route to trigger a USDA FSIS MPI Directory ingest. Optional body: { "csvUrl": "..." } to override discovery. Auth-gated to ADMIN_SEED_OPERATOR_EMAIL.',
  });
}
