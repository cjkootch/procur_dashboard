import 'server-only';
import { db, webhookEvents, type WebhookProvider } from '@procur/db';

const MAX_PAYLOAD_CHARS = 100_000;

export type RecordWebhookInput = {
  provider: WebhookProvider;
  eventId?: string | null;
  eventType?: string | null;
  companyId?: string | null;
  signatureValid?: boolean;
  responseStatus: number;
  processed?: boolean;
  errorMessage?: string | null;
  /** Raw decoded payload — anything JSON-serializable. Will be capped. */
  payload?: unknown;
};

/**
 * Record an inbound webhook receipt for the admin viewer. Always
 * swallows errors — a metering write must never break the webhook
 * handler that called us.
 *
 * Capped at 100k chars of serialized payload to avoid pathological
 * Stripe events bloating one row. The payload column is jsonb so
 * the cap is enforced via JSON.stringify check before insert.
 */
export async function recordWebhookReceipt(input: RecordWebhookInput): Promise<void> {
  let safePayload: unknown = null;
  if (input.payload !== undefined) {
    try {
      const serialized = JSON.stringify(input.payload);
      if (serialized.length <= MAX_PAYLOAD_CHARS) {
        safePayload = input.payload;
      } else {
        // Drop payload for oversized events — record metadata only.
        safePayload = {
          truncated: true,
          length: serialized.length,
          note: `Payload exceeded ${MAX_PAYLOAD_CHARS} chars and was dropped.`,
        };
      }
    } catch {
      safePayload = { error: 'payload not JSON-serializable' };
    }
  }

  try {
    await db.insert(webhookEvents).values({
      provider: input.provider,
      eventId: input.eventId ?? null,
      eventType: input.eventType ?? null,
      companyId: input.companyId ?? null,
      signatureValid: input.signatureValid ?? true,
      responseStatus: input.responseStatus,
      processedAt: input.processed ? new Date() : null,
      errorMessage: input.errorMessage ?? null,
      payload: safePayload,
    });
  } catch (err) {
    console.error('[webhook-events] insert failed', err, {
      provider: input.provider,
      eventType: input.eventType,
    });
  }
}
