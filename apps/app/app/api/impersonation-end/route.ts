import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { auditLog, db, users } from '@procur/db';

/**
 * Stamp an `admin.impersonation_ended` audit row before the staff user
 * signs out of the impersonated session. Pairs with
 * `admin.impersonation_started` (written from the admin app when the
 * actor token was minted) to bracket the impersonation window in the
 * audit trail.
 *
 * Called from ExitImpersonationButton via fetch + keepalive — that way
 * the row lands even though the click handler immediately destroys the
 * Clerk session cookie. Failures don't block the sign-out (the started
 * event is enough to know the session existed).
 */
export async function POST(): Promise<NextResponse> {
  const { userId, sessionClaims } = await auth();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });

  const actor = sessionClaims?.act as { sub?: string } | undefined;
  if (!actor?.sub) {
    // Not an impersonated session — nothing to log.
    return NextResponse.json({ ok: true, skipped: true });
  }

  try {
    const [target, actorRow] = await Promise.all([
      db.query.users.findFirst({
        where: eq(users.clerkId, userId),
        columns: { id: true, email: true, companyId: true },
      }),
      db.query.users.findFirst({
        where: eq(users.clerkId, actor.sub),
        columns: { id: true, email: true },
      }),
    ]);

    await db.insert(auditLog).values({
      companyId: target?.companyId ?? null,
      userId: target?.id ?? null,
      actorUserId: actorRow?.id ?? null,
      action: 'admin.impersonation_ended',
      entityType: 'user',
      entityId: target?.id ?? null,
      metadata: {
        actorEmail: actorRow?.email ?? null,
        actorClerkId: actor.sub,
        targetEmail: target?.email ?? null,
        targetClerkId: userId,
      },
    });
  } catch (err) {
    console.error('[impersonation-end] audit insert failed', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
