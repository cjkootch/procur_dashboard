import Link from 'next/link';
import {
  getFeaturedOpportunities,
  getGlobalStats,
  listActiveCategories,
} from '../lib/queries';
import { SearchBar } from '../components/search-bar';
import { CategoryPills } from '../components/category-pills';
import { OpportunityCard } from '../components/opportunity-card';

// Render at request time. Discover queries on this page filter on
// `opportunities.company_id` (privacy boundary for private uploads),
// and prerendering at build time can crash when Vercel's preview/build
// runtime points at a Neon DB branch that's behind the migration head.
// SSR keeps the page always-fresh and DB-schema-tolerant.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [stats, categories, featured] = await Promise.all([
    getGlobalStats(),
    listActiveCategories(),
    getFeaturedOpportunities(12),
  ]);

  return (
    <>
      <section className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">
            Government tenders from the Caribbean, Latin America, and Africa — all in one place.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-[color:var(--color-muted-foreground)]">
            Procur Discover aggregates live procurement opportunities from{' '}
            {stats.jurisdictions} jurisdictions into a single searchable feed. Free to browse.
          </p>
          <div className="mt-8 max-w-2xl">
            <SearchBar />
          </div>
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 text-sm">
            <div>
              <dt className="text-[color:var(--color-muted-foreground)]">Active opportunities</dt>
              <dd className="text-xl font-semibold">
                {stats.activeOpportunities.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted-foreground)]">Jurisdictions</dt>
              <dd className="text-xl font-semibold">{stats.jurisdictions}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--color-muted-foreground)]">Updated</dt>
              <dd className="text-xl font-semibold">Every 4 hours</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Browse by category</h2>
          <Link className="text-sm underline" href="/opportunities">
            All opportunities →
          </Link>
        </div>
        <CategoryPills categories={categories} />
      </section>

      <section className="mx-auto max-w-6xl px-6 py-6">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Featured opportunities</h2>
          <Link className="text-sm underline" href="/opportunities?sort=value-desc">
            View all →
          </Link>
        </div>
        {featured.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {featured.map((op) => (
              <OpportunityCard key={op.id} op={op} />
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">How Procur works</h2>
          <div className="mt-8 grid gap-8 md:grid-cols-3">
            <Step
              n="1"
              title="Discover"
              body="Free. Aggregated tenders from every Caribbean, LatAm, and African procurement portal we cover."
            />
            <Step
              n="2"
              title="Pursue"
              body="With Procur Pro: track pursuits, assign tasks, answer capture questions, and score win probability."
            />
            <Step
              n="3"
              title="Win"
              body="AI-drafted proposals with compliance matrix, Word export, and jurisdiction-specific templates."
            />
          </div>
          <div className="mt-8">
            <a
              href="https://procur.app"
              className="inline-flex items-center rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-5 py-3 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
            >
              Get Procur Pro →
            </a>
          </div>
        </div>
      </section>
    </>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[color:var(--color-foreground)] text-sm font-semibold text-[color:var(--color-background)]">
        {n}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">{body}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
      <p className="font-medium">No opportunities yet</p>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        Scrapers run every 4-6 hours. Check back soon.
      </p>
    </div>
  );
}
