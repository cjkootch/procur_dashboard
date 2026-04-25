import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness + database health probe.
 *
 * Returns 200 with `{status: "ok"}` only when we can round-trip a
 * trivial query to Postgres. Returns 503 with `{status: "degraded"}`
 * if the DB is unreachable, plus the underlying error message so
 * dashboards can disambiguate connection vs. auth vs. timeout.
 *
 * Vercel's healthcheck integration polls this; before the DB probe
 * was added, a failing database returned 200 because Next was up,
 * masking outages until customer reports came in.
 *
 * 2-second timeout: fast enough to fail loud, generous enough to
 * tolerate transient cold-start latency on Neon's serverless plan.
 */
export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  try {
    const dbCheck = db.execute(sql`select 1 as ok`);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db probe timeout (2s)')), 2000),
    );
    await Promise.race([dbCheck, timeout]);

    return Response.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      checks: { database: 'ok' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        checks: { database: 'error' },
        error: message,
      },
      { status: 503 },
    );
  }
}
