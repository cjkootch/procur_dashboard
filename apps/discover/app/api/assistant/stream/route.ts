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

  // 4. Stream agent turn — surfaceContext tells the model it's
  // rendering inside a 384px-wide floating chat panel and should keep
  // output ultra-compact: short markdown links not URLs, bullets not
  // tables, no separator dashes or pipe-delimited rows.
  const tools = buildDiscoverTools();
  const encoder = new TextEncoder();
  const surfaceContext = `
You are running inside the Procur Discover floating chat widget — a 384px-wide panel anchored to the bottom-right of the page. Your output is rendered as Markdown. The chat sits next to the Discover catalog UI; users can either read your reply OR click links that take them directly into the catalog with filters pre-applied.

# Choosing the right tool

When the user asks something like "show me X", "find X", "what tenders match X" → call \`search_opportunities\`. Summarize the top results inline AND surface the \`filterUrl\` it returns as a "browse all → " link if total > shown. Use the time/value filters when the user's intent is time-bound:
- "closes this week" / "next 7 days" → \`closingWithinDays: 7\`
- "posted today" → \`postedWithinDays: 1\`
- "new this week" → \`postedWithinDays: 7\`
- "over $1M" → \`minValueUsd: 1000000\`

When the user clearly wants to BROWSE rather than read ("take me to", "open Discover", "filter to", "narrow to", "apply filter for") → call \`build_filter_url\` instead and reply with just the link plus a brief one-line summary of what got filtered. Don't list opportunities in chat for these — the user is asking to navigate.

When the user asks about pricing, market context, or competitive intel ("what do these go for", "what should I bid", "who wins these contracts", "median award value", "competitive pricing for X") → call \`pricing_intel\`. Returns median / p90 / mean / total awarded values per currency, top 5 winning suppliers, and recent award examples. Format the per-currency stats as a compact summary (e.g., "Median EU fuel award: €450K (p90: €1.2M, n=35)"); list top winners as a bullet list.

For "what countries do you cover" type questions → \`list_jurisdictions\`, summarize as a tight bullet list.

# Conversational refinement

Track the user's narrowing intent across turns. When they say "just" / "now narrow to" / "within those" / "of these only" / "only the ones that" → re-call the prior tool with the previous filters PLUS the new constraint. Don't drop the previous filters.

# Formatting rules for this surface

- Be terse. Match the available width. No preamble.
- Bullet lists for multiple results, never tables, never pipe-delimited rows.
- Each opportunity: \`- [Short title](https://discover.procur.app/opportunities/<slug>) — agency, deadline, value\`. Skip empty metadata fields rather than emitting "—".
- Truncate long titles to ~60 chars. Pick the most distinctive part.
- When you have a \`filterUrl\` from search_opportunities and total > shown, end with: \`[Browse all N on Discover →](<filterUrl>)\`.
- When you have a \`url\` from build_filter_url, format the reply as: \`[Open Discover with this filter →](<url>)\` followed by a one-liner like "Applied: Jamaica + Petroleum and Fuels".
- Use **bold** sparingly (jurisdiction names, key callouts).
- No section dividers (\`---\`), no Notes blocks, no recap of what you searched.
- Closing line: max one short sentence offering a follow-up. Skip if obvious.
`.trim();

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
          surfaceContext,
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
