import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { listThreads } from '@procur/ai';
import { db, companies, users } from '@procur/db';
import { verifyDiscoverToken } from '@procur/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * List the calling user's assistant threads (newest first, capped at
 * 50). Powers the Threads dropdown in the Discover floating widget.
 *
 * Auth: same Bearer handshake token verified by the stream route.
 * Threads are scoped to (company, user) so a tenant can't see another
 * tenant's chat history even if they shared a Discover deployment.
 */
export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const secret = process.env.DISCOVER_HANDSHAKE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'server_misconfigured: DISCOVER_HANDSHAKE_SECRET not set' },
      { status: 500 },
    );
  }
  const claims = verifyDiscoverToken(token, secret);
  if (!claims) {
    return NextResponse.json({ error: 'invalid_or_expired_token' }, { status: 401 });
  }
  if (!claims.orgId) {
    return NextResponse.json({ error: 'no_company_context' }, { status: 403 });
  }

  const [companyRow, userRow] = await Promise.all([
    db.query.companies.findFirst({ where: eq(companies.clerkOrgId, claims.orgId) }),
    db.query.users.findFirst({ where: eq(users.clerkId, claims.userId) }),
  ]);
  if (!companyRow || !userRow) {
    return NextResponse.json({ error: 'company_or_user_not_synced' }, { status: 503 });
  }

  const threads = await listThreads(companyRow.id, userRow.id);
  return NextResponse.json({ threads });
}
