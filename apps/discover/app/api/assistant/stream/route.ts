import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, companies, users } from '@procur/db';
import { verifyDiscoverToken } from '@procur/utils';
import { streamAgentTurn, type StreamEvent, type AnthropicMessageParam } from '@procur/ai';
import { buildDiscoverTools } from '../../../../lib/assistant-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Streaming assistant endpoint for Discover.
 *
 * Auth: Bearer handshake token (minted by app.procur.app/api/discover-connect
 * and round-tripped via the URL hash on first connect). Verified
 * server-side via the shared DISCOVER_HANDSHAKE_SECRET — no Clerk
 * session required, since Discover sits on a different subdomain than
 * the App and dev-key Clerk sessions don't share cross-origin.
 *
 * Statelessness: no thread persistence on Discover. The client sends
 * the full conversation history per request and we replay it. Keeps
 * the surface light and avoids a second DB schema for chats. Once the
 * UX matures we can add server-side thread storage similar to the
 * main app.
 *
 * Budget: scoped to the user's company via Clerk orgId baked into the
 * handshake token. The same per-company AI budget the main app
 * enforces also applies to Discover queries — no parallel ledger. If
 * the token has no orgId (rare; pre-onboarding users) we reject so
 * usage doesn't go unbilled.
 */

type RequestBody = {
  history?: AnthropicMessageParam[];
  userText: string;
};

export async function POST(req: Request): Promise<Response> {
  // 1. Auth
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
    return NextResponse.json(
      { error: 'invalid_or_expired_token' },
      { status: 401 },
    );
  }
  if (!claims.orgId) {
    return NextResponse.json(
      { error: 'no_company_context — finish onboarding in the main app first' },
      { status: 403 },
    );
  }

  // 2. Resolve company + user from claims
  const [companyRow, userRow] = await Promise.all([
    db.query.companies.findFirst({ where: eq(companies.clerkOrgId, claims.orgId) }),
    db.query.users.findFirst({ where: eq(users.clerkId, claims.userId) }),
  ]);
  if (!companyRow) {
    return NextResponse.json(
      { error: 'company_not_synced — try again in a moment' },
      { status: 503 },
    );
  }
  if (!userRow) {
    return NextResponse.json(
      { error: 'user_not_synced — try again in a moment' },
      { status: 503 },
    );
  }

  // 3. Parse body
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body.userText || typeof body.userText !== 'string') {
    return NextResponse.json({ error: 'missing_user_text' }, { status: 400 });
  }
  const history: AnthropicMessageParam[] = Array.isArray(body.history) ? body.history : [];

  // 4. Stream agent turn
  const tools = buildDiscoverTools();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        for await (const event of streamAgentTurn({
          ctx: { companyId: companyRow.id, userId: userRow.id },
          tools,
          history,
          userText: body.userText,
          companyName: companyRow.name,
          userFirstName: userRow.firstName ?? null,
          planTier: companyRow.planTier,
        })) {
          send(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
