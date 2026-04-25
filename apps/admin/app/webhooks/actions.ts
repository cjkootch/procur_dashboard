'use server';

import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auditLog, db, webhookEvents, type NewWebhookEvent } from '@procur/db';
import {
  guessCompanyIdFromStripeEvent,
  processStripeEvent,
} from '@procur/payments';
import { requireAdmin } from '../../lib/require-admin';

/**
 * Manually replay a stored Stripe webhook event. Loads the original
 * payload from webhook_events, re-runs processStripeEvent against it
 * (bypassing signature verification — admin trust replaces the
 * signature trust), then writes a NEW webhook_events row marking the
 * replay.
 *
 * Why a new row vs. updating the original:
 *   - Preserves the original failure record (debug story stays intact).
 *   - Replay metadata identifies the source row.
 *   - If replay also fails, you get a clean re-failure to look at.
 *
 * Clerk webhooks are NOT replayable from this action — Clerk auto-
 * retries delivery for ~24h, and we'd need to reconstruct the svix
 * signature flow to re-handle from a stored payload. Defer until a
 * customer hits a Clerk-only ops issue we can't otherwise resolve.
 */
export async function replayWebhookEventAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const eventRowId = String(formData.get('eventRowId') ?? '');
  if (!eventRowId) throw new Error('eventRowId required');

  const [original] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, eventRowId))
    .limit(1);
  if (!original) throw new Error('webhook event not found');
  if (original.provider !== 'stripe') {
    throw new Error('replay only supported for stripe webhooks');
  }
  if (!original.payload) {
    throw new Error('original event has no stored payload to replay');
  }

  // The stored payload is the full Stripe event JSON. Drizzle returns
  // jsonb as `unknown`; trust + cast.
  const event = original.payload as Stripe.Event;

  const companyIdGuess =
    original.companyId ?? (await guessCompanyIdFromStripeEvent(event));

  const replayMetadata = {
    replay: true,
    replayOfEventRowId: original.id,
    actorEmail: admin.email,
    originalReceivedAt: original.receivedAt.toISOString(),
  };

  let replayRow: NewWebhookEvent;
  try {
    await processStripeEvent(event);
    replayRow = {
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      companyId: companyIdGuess,
      signatureValid: true,
      responseStatus: 200,
      processedAt: new Date(),
      payload: { ...event, _replayMetadata: replayMetadata },
    };
  } catch (err) {
    replayRow = {
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      companyId: companyIdGuess,
      signatureValid: true,
      responseStatus: 500,
      errorMessage: err instanceof Error ? err.message : String(err),
      payload: { ...event, _replayMetadata: replayMetadata },
    };
  }

  try {
    await db.insert(webhookEvents).values(replayRow);
  } catch (err) {
    console.error('[admin] replay receipt insert failed', err);
  }

  try {
    await db.insert(auditLog).values({
      companyId: companyIdGuess,
      userId: admin.id,
      action: 'admin.webhook_replayed',
      entityType: 'webhook_event',
      entityId: original.id,
      metadata: {
        actorEmail: admin.email,
        provider: 'stripe',
        eventId: event.id,
        eventType: event.type,
        replaySucceeded: replayRow.responseStatus === 200,
        replayError: replayRow.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error('[admin] webhook replay audit insert failed', err);
  }

  revalidatePath('/webhooks');
}
