import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { companies, db } from '@procur/db';
import { getStripe } from '../../../../lib/stripe';
import { recordWebhookReceipt } from '../../../../lib/webhook-events';

type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

export const runtime = 'nodejs';
// Stripe webhook handler must receive the raw body to verify the signature.
export const dynamic = 'force-dynamic';

function planTierFromPriceId(priceId: string | null | undefined): PlanTier {
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.STRIPE_TEAM_PRICE_ID) return 'team';
  return 'pro'; // default when unrecognized
}

async function resolveCompanyId(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<string | null> {
  const metaCompany = subscription.metadata?.companyId;
  if (metaCompany) return metaCompany;

  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;
  const row = await db.query.companies.findFirst({
    where: eq(companies.stripeCustomerId, customerId),
    columns: { id: true },
  });
  return row?.id ?? null;
}

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
  // even if the handler errors. Many event types won't have a customer
  // — we just leave it null in that case.
  let companyIdGuess: string | null = null;
  try {
    const obj = event.data.object as { customer?: string | { id?: string } } | null;
    const customerId =
      typeof obj?.customer === 'string' ? obj.customer : obj?.customer?.id ?? null;
    if (customerId) {
      const row = await db.query.companies.findFirst({
        where: eq(companies.stripeCustomerId, customerId),
        columns: { id: true },
      });
      companyIdGuess = row?.id ?? null;
    }
  } catch {
    // ignore — best-effort only
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const companyId =
          session.client_reference_id ??
          (await (async () => {
            if (!session.customer) return null;
            const customerId =
              typeof session.customer === 'string' ? session.customer : session.customer.id;
            const row = await db.query.companies.findFirst({
              where: eq(companies.stripeCustomerId, customerId),
              columns: { id: true },
            });
            return row?.id ?? null;
          })());
        if (!companyId) break;
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id ?? null;
        await db
          .update(companies)
          .set({
            stripeCustomerId:
              typeof session.customer === 'string'
                ? session.customer
                : session.customer?.id ?? null,
            stripeSubscriptionId: subId,
            subscriptionStatus: 'active',
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const companyId = await resolveCompanyId(stripe, sub);
        if (!companyId) break;
        const priceId = sub.items.data[0]?.price.id;
        const tier = planTierFromPriceId(priceId);
        await db
          .update(companies)
          .set({
            stripeSubscriptionId: sub.id,
            subscriptionStatus: sub.status,
            planTier: sub.status === 'active' || sub.status === 'trialing' ? tier : 'free',
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const companyId = await resolveCompanyId(stripe, sub);
        if (!companyId) break;
        await db
          .update(companies)
          .set({
            planTier: 'free',
            subscriptionStatus: 'canceled',
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
        break;
      }
    }
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
