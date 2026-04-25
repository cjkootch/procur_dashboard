import type Stripe from 'stripe';
import {
  guessCompanyIdFromStripeEvent,
  processStripeEvent,
} from '@procur/payments';
import { getStripe } from '../../../../lib/stripe';
import { recordWebhookReceipt } from '../../../../lib/webhook-events';

export const runtime = 'nodejs';
// Stripe webhook handler must receive the raw body to verify the signature.
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('STRIPE_WEBHOOK_SECRET not configured', { status: 500 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    await recordWebhookReceipt({
      provider: 'stripe',
      responseStatus: 400,
      signatureValid: false,
      errorMessage: 'missing stripe-signature header',
    });
    return new Response('missing stripe-signature', { status: 400 });
  }

  const body = await req.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    console.error('stripe webhook signature error', err);
    await recordWebhookReceipt({
      provider: 'stripe',
      responseStatus: 401,
      signatureValid: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return new Response('invalid signature', { status: 401 });
  }

  // Best-effort companyId resolution up front so the receipt has it
  // even if the handler errors. Many event types won't have a customer.
  const companyIdGuess = await guessCompanyIdFromStripeEvent(event);

  try {
    await processStripeEvent(event);
  } catch (err) {
    console.error('stripe webhook handler error', err);
    await recordWebhookReceipt({
      provider: 'stripe',
      eventId: event.id,
      eventType: event.type,
      companyId: companyIdGuess,
      responseStatus: 500,
      errorMessage: err instanceof Error ? err.message : String(err),
      payload: event,
    });
    return new Response('handler error', { status: 500 });
  }

  await recordWebhookReceipt({
    provider: 'stripe',
    eventId: event.id,
    eventType: event.type,
    companyId: companyIdGuess,
    responseStatus: 200,
    processed: true,
    payload: event,
  });
  return new Response('ok', { status: 200 });
}
