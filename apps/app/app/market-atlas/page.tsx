import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listAtlasCountries } from '@procur/catalog';

export const dynamic = 'force-dynamic';

/**
 * Market atlas index. One row per country with at least one
 * non-superseded fact. Recency-ordered so the most actively-explored
 * markets surface first.
 */
export default async function MarketAtlasIndexPage() {
  await requireCompany();
  const countries = await listAtlasCountries();

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Market Atlas</h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-muted-foreground)]">
          Cross-probe memory of market structure — gatekeepers, dead ends,
          referrals, signal quality, compliance quirks. Operators write
          facts as they discover them; the agent writes facts as it
          observes patterns. Facts persist so the next probe in this
          market starts smarter.
        </p>
      </header>

      {countries.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No facts logged yet. Run a Market Probe and use the Market
          Atlas panel on the probe detail page to capture what you
          learn.
        </div>
      ) : (
        <ul className="space-y-2">
          {countries.map((c) => (
            <Link
              key={c.country}
              href={`/market-atlas/${c.country}`}
              className="flex items-baseline justify-between rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div>
                <span className="text-sm font-mono">{c.country}</span>
                <span className="ml-3 text-sm text-[color:var(--color-muted-foreground)]">
                  {c.factCount} fact{c.factCount === 1 ? '' : 's'}
                </span>
              </div>
              <time
                className="text-xs text-[color:var(--color-muted-foreground)]"
                dateTime={c.lastUpdatedAt.toISOString()}
              >
                updated {c.lastUpdatedAt.toLocaleDateString()}
              </time>
            </Link>
          ))}
        </ul>
      )}
    </div>
  );
}
