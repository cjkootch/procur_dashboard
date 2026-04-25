import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { companies, db } from '@procur/db';

type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

/**
 * Stripe event business logic, factored out of the webhook route so
 * the admin replay flow can call it on a stored payload (bypassing
 * signature verification — admin trust replaces the signature trust).
 *
 * Returns the resolved companyId (best-effort) so the caller can stamp
 * the webhook_events row.
 */
export async function processStripeEvent(event: Stripe.Event): Promise<{
  companyId: string | null;
}> {
  let companyIdGuess: string | null = null;

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
      companyIdGuess = companyId;
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const companyId = await resolveSubscriptionCompanyId(sub);
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
      companyIdGuess = companyId;
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const companyId = await resolveSubscriptionCompanyId(sub);
      if (!companyId) break;
      await db
        .update(companies)
        .set({
          planTier: 'free',
          subscriptionStatus: 'canceled',
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
      companyIdGuess = companyId;
      break;
    }
  }

  return { companyId: companyIdGuess };
}

/** Best-effort companyId from event payload, before the handler runs. */
export async function guessCompanyIdFromStripeEvent(event: Stripe.Event): Promise<string | null> {
  try {
    const obj = event.data.object as { customer?: string | { id?: string } } | null;
    const customerId =
      typeof obj?.customer === 'string' ? obj.customer : obj?.customer?.id ?? null;
    if (!customerId) return null;
    const row = await db.query.companies.findFirst({
      where: eq(companies.stripeCustomerId, customerId),
      columns: { id: true },
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function planTierFromPriceId(priceId: string | null | undefined): PlanTier {
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.STRIPE_TEAM_PRICE_ID) return 'team';
  return 'pro';
}

async function resolveSubscriptionCompanyId(
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
