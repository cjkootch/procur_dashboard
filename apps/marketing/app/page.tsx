import Link from 'next/link';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

const PRODUCTS = [
  {
    name: 'Discover',
    badge: 'Free',
    headline: 'Every government tender across the Caribbean, LatAm, and Africa.',
    bullets: [
      '15+ procurement portals scraped every 4 hours',
      'AI summary, requirement extraction, and category tagging on every notice',
      'Daily and weekly email digests matched to your capabilities',
    ],
    href: `${DISCOVER_URL}`,
    cta: 'Browse tenders',
  },
  {
    name: 'Capture',
    badge: '$199 / mo',
    headline: 'Pipeline for the bids you actually pursue.',
    bullets: [
      'Kanban from identification through award, with stage-gated capture questions',
      'Win-probability scoring and weighted pipeline value',
      'Tasks, owners, and deadlines tied to every pursuit',
    ],
    href: `${APP_URL}/capture`,
    cta: 'Open Capture',
  },
  {
    name: 'Proposal',
    badge: '$599 / mo',
    headline: 'AI-drafted responses that pass compliance review.',
    bullets: [
      'Tender shredding into a structured outline and compliance matrix',
      'Section drafts retrieved from your library and past performance',
      'Final AI review with red/yellow/green verdict before submission',
    ],
    href: `${APP_URL}/proposal`,
    cta: 'See Proposal',
  },
  {
    name: 'Pricer',
    badge: '$399 / mo',
    headline: 'Cost models built from the tender, not from a spreadsheet.',
    bullets: [
      'Labor categories, indirect rates, multi-year escalation',
      'Pricing strategy extracted from the solicitation',
      'Historical award benchmarking across your jurisdictions',
    ],
    href: `${APP_URL}/pricer`,
    cta: 'Open Pricer',
  },
  {
    name: 'Contract',
    badge: 'Enterprise',
    headline: 'Track every obligation from award to closeout.',
    bullets: [
      'Hierarchical inventory: prime contracts, task orders, subcontracts',
      'Obligation tracking with recurring deadlines',
      'Document store with version history',
    ],
    href: `${APP_URL}/contract`,
    cta: 'Open Contract',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Discover',
    body:
      'Procur scrapes 15+ procurement portals across emerging markets every few hours. Search by jurisdiction, category, or keyword. Free forever.',
  },
  {
    number: '02',
    title: 'Pursue',
    body:
      'Track promising tenders in a kanban pipeline. Answer capture questions, assign tasks, score win probability — built for how proposal teams actually work.',
  },
  {
    number: '03',
    title: 'Propose',
    body:
      'AI shreds the tender into a compliance matrix, drafts each section against your content library, and red-team-reviews the response before you submit.',
  },
  {
    number: '04',
    title: 'Win and deliver',
    body:
      'Awarded contracts move into Contract for obligation tracking. Historical wins feed Pricer benchmarks for your next bid.',
  },
];

const JURISDICTIONS = [
  { name: 'Jamaica', portal: 'GOJEP', live: true },
  { name: 'Guyana', portal: 'NPTAB', live: true },
  { name: 'Trinidad & Tobago', portal: 'eGP', live: true },
  { name: 'Dominican Republic', portal: 'DGCP', live: true },
  { name: 'Barbados', portal: 'GIS / BPPD', live: false },
  { name: 'Bahamas', portal: 'MoF', live: false },
  { name: 'St. Lucia', portal: 'CDB-funded', live: false },
  { name: 'CDB · IDB · World Bank', portal: 'Multilateral', live: false },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="px-6 pt-20 pb-16 md:pt-28 md:pb-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-[color:var(--color-border)] px-3 py-1 text-xs text-[color:var(--color-muted-foreground)]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live across 4 Caribbean markets · expanding
          </p>
          <h1 className="text-balance text-5xl font-semibold tracking-tight md:text-6xl">
            Win government contracts in emerging markets.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-balance text-lg text-[color:var(--color-muted-foreground)]">
            Procur is the AI-native procurement platform for the Caribbean, Latin America, and
            Africa. Aggregate every tender, manage your pursuit pipeline, and draft compliant
            proposals in a fraction of the time.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={DISCOVER_URL}
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-5 py-2.5 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
            >
              Browse tenders — free
            </a>
            <Link
              href="/pricing"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-5 py-2.5 text-sm font-medium hover:border-[color:var(--color-foreground)]"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
            No credit card required. Upgrade when you start tracking pursuits.
          </p>
        </div>
      </section>

      {/* Stat strip */}
      <section className="border-y border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-6 py-10">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 text-center md:grid-cols-4">
          <Stat value="4" label="Live jurisdictions" />
          <Stat value="15+" label="Portals planned" />
          <Stat value="2" label="Languages — EN + ES" />
          <Stat value="Q4" label="Africa coverage live" />
        </div>
      </section>

      {/* Products */}
      <section id="products" className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <header className="mb-10 max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Five products. One workflow.
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              From tender notice to contract closeout.
            </h2>
          </header>
          <div className="grid gap-4 md:grid-cols-2">
            {PRODUCTS.map((p) => (
              <article
                key={p.name}
                className="flex flex-col rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xl font-semibold">{p.name}</h3>
                  <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                    {p.badge}
                  </span>
                </div>
                <p className="text-base font-medium">{p.headline}</p>
                <ul className="mt-4 space-y-2 text-sm text-[color:var(--color-muted-foreground)]">
                  {p.bullets.map((b) => (
                    <li key={b} className="flex gap-2">
                      <span className="mt-0.5 text-[color:var(--color-foreground)]/40">·</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={p.href}
                  className="mt-5 inline-flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  {p.cta} <span>→</span>
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <header className="mb-10 max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              How it works
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Built for how proposal teams actually work.
            </h2>
          </header>
          <ol className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li
                key={s.number}
                className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5"
              >
                <p className="text-xs font-mono text-[color:var(--color-muted-foreground)]">
                  {s.number}
                </p>
                <p className="mt-2 text-base font-semibold">{s.title}</p>
                <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                  {s.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Coverage */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <header className="mb-10 max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Jurisdiction coverage
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Where US-focused tools don&rsquo;t reach.
            </h2>
            <p className="mt-3 text-base text-[color:var(--color-muted-foreground)]">
              We start where the global procurement-tech market is least served. Every jurisdiction
              gets normalized currency, deadline parsing, and AI-extracted requirements out of the box.
            </p>
          </header>
          <div className="grid gap-2 md:grid-cols-4">
            {JURISDICTIONS.map((j) => (
              <div
                key={j.name}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{j.name}</p>
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {j.portal}
                  </p>
                </div>
                {j.live ? (
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    Live
                  </span>
                ) : (
                  <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-muted-foreground)]">
                    Soon
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-[color:var(--color-border)] px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            Start with Discover. Upgrade when you&rsquo;re bidding.
          </h2>
          <p className="mt-4 text-base text-[color:var(--color-muted-foreground)]">
            Browse every tender we aggregate, free forever. Add Capture when you start tracking
            pursuits, then layer Proposal and Pricer when you&rsquo;re ready to draft and price.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={DISCOVER_URL}
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-5 py-2.5 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
            >
              Start free
            </a>
            <Link
              href="/pricing"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-5 py-2.5 text-sm font-medium hover:border-[color:var(--color-foreground)]"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-3xl font-semibold tracking-tight md:text-4xl">{value}</p>
      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">{label}</p>
    </div>
  );
}
