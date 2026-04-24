'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { companies, db } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { getStripe, priceIdFor, type PlanKey } from '../../lib/stripe';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

async function ensureStripeCustomer(
  companyId: string,
  email: string,
  name: string,
): Promise<string> {
  const existing = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { stripeCustomerId: true },
  });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { companyId },
  });

  await db
    .update(companies)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  return customer.id;
}

export async function startCheckoutAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const plan = String(formData.get('plan') ?? '') as PlanKey;
  if (!['pro', 'team', 'pricer'].includes(plan)) {
    throw new Error(`unknown plan "${plan}"`);
  }

  const customerId = await ensureStripeCustomer(
    company.id,
    user.email,
    company.name,
  );

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceIdFor(plan), quantity: 1 }],
    success_url: `${APP_URL}/billing?checkout=success`,
    cancel_url: `${APP_URL}/billing?checkout=cancelled`,
    client_reference_id: company.id,
    subscription_data: {
      metadata: { companyId: company.id, plan },
    },
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
  });

  if (!session.url) throw new Error('Stripe returned no checkout URL');
  redirect(session.url);
}

export async function openCustomerPortalAction(): Promise<void> {
  const { user, company } = await requireCompany();
  const customerId = await ensureStripeCustomer(
    company.id,
    user.email,
    company.name,
  );

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${APP_URL}/billing`,
  });

  redirect(portal.url);
}
