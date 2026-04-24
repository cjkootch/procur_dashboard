import 'server-only';
import Stripe from 'stripe';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (!cached) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    cached = new Stripe(key, {
      apiVersion: '2025-10-29.clover' as Stripe.LatestApiVersion,
      typescript: true,
    });
  }
  return cached;
}

export type PlanKey = 'pro' | 'team' | 'pricer';

/**
 * Stripe price IDs per plan. Create the products in Stripe dashboard, then
 * drop the price IDs into env. `pricer` is an add-on (stack on top of pro/team).
 */
export function priceIdFor(plan: PlanKey): string {
  const map: Record<PlanKey, string | undefined> = {
    pro: process.env.STRIPE_PRO_PRICE_ID,
    team: process.env.STRIPE_TEAM_PRICE_ID,
    pricer: process.env.STRIPE_PRICER_PRICE_ID,
  };
  const id = map[plan];
  if (!id) throw new Error(`No Stripe price ID for plan "${plan}"`);
  return id;
}

export const PLAN_LABEL: Record<PlanKey, string> = {
  pro: 'Pro',
  team: 'Team',
  pricer: 'Pricer add-on',
};

export const PLAN_PRICE_USD: Record<PlanKey, number> = {
  pro: 199,
  team: 399,
  pricer: 399,
};
