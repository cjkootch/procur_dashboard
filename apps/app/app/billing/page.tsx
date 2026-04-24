import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import type { PlanKey } from '../../lib/stripe';
import { openCustomerPortalAction, startCheckoutAction } from './actions';

export const dynamic = 'force-dynamic';

const PLANS: Array<{
  key: PlanKey | 'free';
  name: string;
  price: string;
  description: string;
  features: string[];
  cta: string;
}> = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    description: 'Browse Discover + track up to 5 active pursuits.',
    features: [
      'Unlimited Discover browsing',
      '5 active pursuits',
      'Manual pipeline + tasks',
      'Email digests',
    ],
    cta: 'Current',
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$199/mo',
    description: 'Unlimited pursuits, dashboard customization, task templates.',
    features: [
      'Unlimited pursuits',
      'Customizable dashboard',
      'Task templates by stage',
      'Basic reports',
      'AI enrichment on all pursuits',
    ],
    cta: 'Upgrade to Pro',
  },
  {
    key: 'team',
    name: 'Team',
    price: '$399/mo',
    description: 'Everything in Pro, plus team assignment and API access.',
    features: [
      'Everything in Pro',
      'Multi-user assignment',
      'Team reports',
      'API access',
      'Priority support',
    ],
    cta: 'Upgrade to Team',
  },
];

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const checkoutState = Array.isArray(sp.checkout) ? sp.checkout[0] : sp.checkout;
  const reason = Array.isArray(sp.reason) ? sp.reason[0] : sp.reason;

  const { company } = await requireCompany();
  const currentTier = company.planTier;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Current plan: <span className="font-medium capitalize">{currentTier}</span>
          {company.stripeSubscriptionId && (
            <>
              {' · '}
              <form action={openCustomerPortalAction} className="inline">
                <button type="submit" className="underline">
                  Manage in Stripe portal →
                </button>
              </form>
            </>
          )}
        </p>
      </header>

      {reason === 'pursuit-cap' && (
        <div className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-brand)] bg-[color:var(--color-brand)]/5 p-4 text-sm">
          <p className="font-medium">You&rsquo;ve hit the free-tier pursuit limit (5 active).</p>
          <p className="mt-1 text-[color:var(--color-muted-foreground)]">
            Upgrade to Pro for unlimited pursuits, or close out existing ones first.
          </p>
        </div>
      )}
      {checkoutState === 'success' && (
        <div className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 p-3 text-sm">
          Checkout complete. Your plan will update as soon as Stripe confirms the subscription.
        </div>
      )}
      {checkoutState === 'cancelled' && (
        <div className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-sm text-[color:var(--color-muted-foreground)]">
          Checkout cancelled — no changes made.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {PLANS.map((plan) => {
          const isCurrent = plan.key === currentTier || (plan.key === 'free' && currentTier === 'free');
          return (
            <article
              key={plan.key}
              className={`flex flex-col rounded-[var(--radius-lg)] border p-6 ${
                isCurrent
                  ? 'border-[color:var(--color-foreground)]'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              <div className="mb-4">
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                <p className="mt-1 text-2xl font-semibold">{plan.price}</p>
                <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
                  {plan.description}
                </p>
              </div>
              <ul className="mb-6 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-[color:var(--color-muted-foreground)]">·</span>
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-auto">
                {plan.key === 'free' ? (
                  <span className="block rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 text-center text-sm text-[color:var(--color-muted-foreground)]">
                    {isCurrent ? 'Current plan' : '—'}
                  </span>
                ) : (
                  <form action={startCheckoutAction}>
                    <input type="hidden" name="plan" value={plan.key} />
                    <button
                      type="submit"
                      disabled={isCurrent}
                      className={`w-full rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium ${
                        isCurrent
                          ? 'cursor-not-allowed border border-[color:var(--color-border)] text-[color:var(--color-muted-foreground)]'
                          : 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)] hover:opacity-90'
                      }`}
                    >
                      {isCurrent ? 'Current plan' : plan.cta}
                    </button>
                  </form>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-[color:var(--color-muted-foreground)]">
        Procur is available in USD. Prices are exclusive of tax; Stripe Tax applies
        jurisdiction-appropriate rates at checkout.
      </p>

      <nav className="mt-8 text-sm">
        <Link href="/capture" className="underline">
          ← Back to Capture
        </Link>
      </nav>
    </div>
  );
}
