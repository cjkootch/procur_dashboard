'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { clerkClient } from '@clerk/nextjs/server';
import { auditLog, db, users } from '@procur/db';
import { requireAdmin } from '../../../lib/require-admin';

/**
 * Mint a Clerk actor token and redirect the staff user to it.
 *
 * Flow:
 *   1. Admin clicks "Impersonate" next to a tenant member.
 *   2. We look up the target user's clerkId.
 *   3. clerkClient().actorTokens.create() with actor.sub = admin.clerkId
 *      returns a one-time-use URL hosted on Clerk.
 *   4. We audit-log the action (who, whom, when) BEFORE redirecting so
 *      the trail exists even if the redirect fails.
 *   5. Redirect to the actor token URL — Clerk handles the session
 *      handshake and lands the staff member on the customer app, signed
 *      in as the target user with `act` claims set.
 *
 * Token defaults: 1 hour to redeem, 30 minute session — enough to
 * debug, short enough that a forgotten browser tab won't sit live for
 * days.
 *
 * Both apps must share the same Clerk instance (publishable +
 * secret keys) for the cookie handshake to land in the customer app's
 * domain after the staff redeems the token.
 */
export async function startImpersonationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const targetUserId = String(formData.get('targetUserId') ?? '');
  if (!targetUserId) throw new Error('targetUserId required');

  const target = await db.query.users.findFirst({
    where: eq(users.id, targetUserId),
    columns: { id: true, clerkId: true, email: true, companyId: true },
  });
  if (!target) throw new Error('target user not found');

  const client = await clerkClient();
  let actorToken;
  try {
    actorToken = await client.actorTokens.create({
      userId: target.clerkId,
      actor: { sub: admin.clerkId },
      // Token redemption window. Default 1h is fine; making it explicit.
      expiresInSeconds: 60 * 60,
      // Session created from the redeemed token lasts 30m. Forces the
      // staff user to re-impersonate if they need a longer debug session.
      sessionMaxDurationInSeconds: 30 * 60,
    });
  } catch (err) {
    // Most common: Clerk plan doesn't allow actor tokens, or the API
    // rejected the request. Surface a clear server-side error rather
    // than redirecting into a broken Clerk URL.
    throw new Error(
      `Could not create impersonation token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!actorToken.url) {
    throw new Error('Clerk returned an actor token without a redeem URL');
  }

  // Audit BEFORE the redirect. The audit row stamps the actor (admin)
  // and the entity (target user), with the target's company id for
  // tenant-scoped filtering in /audit.
  try {
    await db.insert(auditLog).values({
      companyId: target.companyId ?? null,
      userId: admin.id,
      action: 'admin.impersonation_started',
      entityType: 'user',
      entityId: target.id,
      metadata: {
        actorEmail: admin.email,
        targetEmail: target.email,
        targetClerkId: target.clerkId,
        actorTokenId: actorToken.id,
        sessionMaxSeconds: 30 * 60,
      },
    });
  } catch (err) {
    console.error('[admin] impersonation audit insert failed', err);
    // Don't block the redirect on a logging failure — the Clerk
    // dashboard still has the actor token record as a fallback trail.
  }

  redirect(actorToken.url);
}
