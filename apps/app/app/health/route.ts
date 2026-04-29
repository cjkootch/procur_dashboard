import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /health — unauthenticated liveness probe.
 *
 * Used by:
 *   - Fly.io's tcp/http liveness checks (configured in fly.toml)
 *   - Vex's /admin/procur/healthcheck → socket-level reachability
 *     (the deeper probes hit the authenticated /api/intelligence/*
 *     endpoints)
 *
 * Stays at the root, NOT under /api, so platform health probes can
 * be configured without leaking the auth boundary into the URL
 * scheme.
 *
 * Returns 200 with a tiny JSON body so a probe gets both a status
 * code and a content-length — enough for any reasonable LB to
 * declare us alive without paying a DB round-trip.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'procur-prod',
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        // Don't let intermediaries cache liveness — it'd defeat the
        // point if a 200 from 5 minutes ago kept being served while
        // the process is actually down.
        'Cache-Control': 'no-store',
      },
    },
  );
}
