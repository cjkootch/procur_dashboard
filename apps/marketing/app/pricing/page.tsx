import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing | Procur',
  description:
    'Procur pricing — free Discover, $199/mo Pro, $399/mo Team, and enterprise options for government contracting in Caribbean, Latin America, and Africa.',
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

type PlanCard = {
  name: string;
  price: string;
  cadence?: string;
  description: string;
  features: string[];
  cta: { label: string; href: string };
  featured?: boolean;
};

const PLANS: PlanCard[] = [
  {
    name: 'Discover',
    price: 'Free',
    description: 'Browse and search every tender we aggregate. Email alerts included.',
    features: [
      'Unlimited Discover browsing',
      'Daily + weekly email digests',
      'Track up to 5 pursuits',
      'All 15+ jurisdictions',
    ],
    cta: { label: 'Start free', href: `${DISCOVER_URL}` },
  },
  {
    name: 'Pro',
    price: '$199',
    cadence: '/ month',
    description: 'Unlimited pursuits, task templates, AI enrichment on every tender you track.',
    features: [
      'Unlimited pursuits',
      'Customizable dashboard',
      'Task templates by pipeline stage',
      'Capture questions + bid decision workflow',
      'AI requirements extraction',
      'Win probability scoring',
    ],
    cta: { label: 'Upgrade to Pro', href: `${APP_URL}/billing` },
    featured: true,
  },
  {
    name: 'Team',
    price: '$399',
    cadence: '/ month',
    description: 'For companies bidding in parallel. Multi-user assignment, team reports, API.',
    features: [
      'Everything in Pro',
      'Multi-user assignment',
      'Team activity + win-rate reports',
      'REST API access',
      'Priority support',
    ],
    cta: { label: 'Upgrade to Team', href: `${APP_URL}/billing` },
  },
];

const ADDONS = [
  {
    name: 'Proposal',
    price: '$599 / month',
    description:
      'AI proposal generation: tender shredding, compliance matrix, section drafting, Word export.',
  },
  {
    name: 'Pricer',
    price: '$399 / month',
    description: 'Cost estimation with labor category modeling, indirect rates, and historical award benchmarking.',
  },
  {
    name: 'Contract',
    price: 'Enterprise',
    description: 'Post-award obligation tracking, task orders, and subcontract management.',
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-12 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Pricing</h1>
        <p className="mt-3 text-base text-[color:var(--color-muted-foreground)]">
          Start free. Upgrade when you&rsquo;re actively pursuing contracts.
        </p>
      </header>

      <div className="grid gap-5 md:grid-cols-3">
        {PLANS.map((plan) => (
          <article
            key={plan.name}
            className={`flex flex-col rounded-[var(--radius-lg)] border p-6 ${
              plan.featured
                ? 'border-[color:var(--color-foreground)] shadow-sm'
                : 'border-[color:var(--color-border)]'
            }`}
          >
            <div className="mb-4">
              <h2 className="text-lg font-semibold">{plan.name}</h2>
              <p className="mt-1 flex items-baseline gap-1">
                <span className="text-3xl font-semibold">{plan.price}</span>
                {plan.cadence && (
                  <span className="text-sm text-[color:var(--color-muted-foreground)]">
                    {plan.cadence}
                  </span>
                )}
              </p>
              <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
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
            <a
              href={plan.cta.href}
              className={`mt-auto block rounded-[var(--radius-md)] px-3 py-2 text-center text-sm font-medium ${
                plan.featured
                  ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)] hover:opacity-90'
                  : 'border border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
              }`}
            >
              {plan.cta.label}
            </a>
          </article>
        ))}
      </div>

      <section className="mt-16">
        <h2 className="mb-4 text-xl font-semibold tracking-tight">Add-on products</h2>
        <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
          Stack on top of Pro or Team when you&rsquo;re ready.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          {ADDONS.map((a) => (
            <div
              key={a.name}
              className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5"
            >
              <p className="font-semibold">{a.name}</p>
              <p className="mt-1 text-sm">{a.price}</p>
              <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
                {a.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 text-sm text-[color:var(--color-muted-foreground)]">
        <p>
          Pricing is in USD and exclusive of applicable tax. Stripe Tax adds jurisdictional tax at
          checkout. Cancel anytime from the billing portal — no annual contracts required.
        </p>
        <p className="mt-3">
          Questions? Email{' '}
          <a className="underline" href="mailto:hello@procur.app">
            hello@procur.app
          </a>
          .
        </p>
      </section>

      <nav className="mt-12 flex items-center justify-center gap-6 text-sm">
        <Link className="hover:underline" href="/">
          ← Back to home
        </Link>
        <a className="hover:underline" href={DISCOVER_URL}>
          Browse tenders →
        </a>
      </nav>
    </div>
  );
}
