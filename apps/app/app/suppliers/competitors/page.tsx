import Link from 'next/link';
import { getCompetitorOverview, getRecentCompetitorNews } from '@procur/catalog';
import { AppShell } from '../../../components/shell/AppShell';
import { CompetitorCard } from './_components/CompetitorCard';

export const dynamic = 'force-dynamic';

/**
 * Competitor dashboard. Surfaces every known_entities row tagged
 * 'competitor' (default) or every role='trader' (broadened scope),
 * with KPI tiles per competitor + a recent-news feed at the bottom.
 *
 * Profile click-through goes to /entities/[slug] (already built —
 * unified profile renders capabilities + ownership chain + public
 * tender activity).
 *
 * Filters live in URL params:
 *   ?category=crude-oil
 *   ?country=CH
 *   ?scope=all-traders     (default 'curated' = competitor-tagged only)
 */

interface Props {
  searchParams: Promise<{
    category?: string;
    country?: string;
    scope?: 'curated' | 'all-traders';
  }>;
}

const CATEGORIES = [
  { slug: 'crude-oil', label: 'Crude oil' },
  { slug: 'diesel', label: 'Diesel' },
  { slug: 'gasoline', label: 'Gasoline' },
  { slug: 'jet-fuel', label: 'Jet fuel' },
  { slug: 'lpg', label: 'LPG' },
  { slug: 'marine-bunker', label: 'Marine bunker' },
];

export default async function CompetitorsPage({ searchParams }: Props) {
  const params = await searchParams;
  const scope = params.scope === 'all-traders' ? 'all-traders' : 'curated';
  const [overview, recentNews] = await Promise.all([
    safe(() => getCompetitorOverview({
      category: params.category,
      country: params.country?.toUpperCase(),
      scope,
    })),
    safe(() => getRecentCompetitorNews({ daysBack: 30, limit: 25 })),
  ]);

  const competitors = overview ?? [];
  const news = recentNews ?? [];

  // KPI rollup at the top.
  const totalCompetitors = competitors.length;
  const totalAwards = competitors.reduce((s, c) => s + c.totalAwards, 0);
  const totalValueUsd = competitors.reduce((s, c) => s + (c.totalValueUsd ?? 0), 0);
  const totalNews90d = competitors.reduce((s, c) => s + c.newsEventsLast90d, 0);
  const decliningCount = competitors.filter(
    (c) => c.velocityChangePct != null && c.velocityChangePct <= -0.5,
  ).length;

  const buildHref = (overrides: Partial<Props['searchParams'] extends Promise<infer U> ? U : never>) => {
    const next = {
      category: params.category,
      country: params.country,
      scope: params.scope,
      ...overrides,
    };
    const query = new URLSearchParams();
    if (next.category) query.set('category', next.category);
    if (next.country) query.set('country', next.country);
    if (next.scope && next.scope !== 'curated') query.set('scope', next.scope);
    const qs = query.toString();
    return `/suppliers/competitors${qs ? `?${qs}` : ''}`;
  };

  return (
    <AppShell title="Competitors">
      <div className="mx-auto max-w-7xl px-6 py-6 bg-[color:var(--color-muted)]/40 min-h-[calc(100vh-49px)]">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">Competitor universe</h1>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Trading houses + state-affiliated traders operating in our lane. Click a card to open the unified
            profile (capabilities, ownership chain, public-tender history). Recent news surfaces
            distress / motivation events from Layer 3 ingest workers.
          </p>
        </header>

        {/* KPI strip */}
        <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Tracked" value={totalCompetitors.toString()} />
          <Kpi
            label="Public-tender awards"
            value={totalAwards.toLocaleString()}
            sub={fmtUsd(totalValueUsd)}
          />
          <Kpi
            label="News events (90d)"
            value={totalNews90d.toString()}
            sub={
              totalNews90d === 0
                ? 'workers populate as RSS / EDGAR / RECAP fire'
                : 'force majeure, restructuring, etc.'
            }
          />
          <Kpi
            label="Velocity declines"
            value={decliningCount.toString()}
            sub="awards down 50%+ vs prior 90d"
            accent={decliningCount > 0 ? 'down' : undefined}
          />
          <Kpi
            label="Scope"
            value={scope === 'curated' ? 'curated' : 'all traders'}
            sub={
              scope === 'curated' ? (
                <Link href={buildHref({ scope: 'all-traders' })} className="underline">
                  expand to all traders
                </Link>
              ) : (
                <Link href={buildHref({ scope: 'curated' })} className="underline">
                  narrow to curated
                </Link>
              ) as unknown as string
            }
          />
        </section>

        {/* Filter chips */}
        <section className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Filter:
          </span>
          <FilterChip
            href={buildHref({ category: undefined })}
            label="All categories"
            active={!params.category}
          />
          {CATEGORIES.map((c) => (
            <FilterChip
              key={c.slug}
              href={buildHref({ category: c.slug })}
              label={c.label}
              active={params.category === c.slug}
            />
          ))}
          {params.country && (
            <Link
              href={buildHref({ country: undefined })}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-background)]"
            >
              {params.country.toUpperCase()} ✕
            </Link>
          )}
        </section>

        {/* Competitor grid */}
        <section className="mb-8">
          {competitors.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
              {scope === 'curated' ? (
                <>
                  No competitor-tagged entities match these filters. Run{' '}
                  <code>pnpm --filter @procur/db seed-known-entities</code> to load the curated trading-house seed,
                  or{' '}
                  <Link className="underline" href={buildHref({ scope: 'all-traders' })}>
                    expand to all traders
                  </Link>
                  .
                </>
              ) : (
                <>No traders match these filters.</>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {competitors.map((c) => (
                <CompetitorCard key={c.knownEntityId} row={c} />
              ))}
            </div>
          )}
        </section>

        {/* Recent news feed */}
        <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Recent news (30d)
            </h2>
            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
              entity_news_events filtered to competitor-tagged entities · relevance ≥ 0.5
            </span>
          </div>
          {news.length === 0 ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              No events yet. The Layer 3 ingest workers (SEC EDGAR / RECAP bankruptcy / trade-press RSS)
              populate this feed automatically — items appear as the workers fire on their cron schedule.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[color:var(--color-border)]/50">
              {news.map((n) => (
                <li key={n.id} className="grid grid-cols-[88px_140px_1fr] items-start gap-3 py-2 text-xs">
                  <span className="font-mono text-[10px] tabular-nums text-[color:var(--color-muted-foreground)]">
                    {n.eventDate}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                    {n.eventType.replace(/_/g, ' ')}
                  </span>
                  <div>
                    {n.knownEntitySlug && n.knownEntityName ? (
                      <Link
                        href={`/entities/${n.knownEntitySlug}`}
                        className="font-medium hover:underline"
                      >
                        {n.knownEntityName}
                      </Link>
                    ) : (
                      <span className="font-medium">{n.sourceEntityName}</span>
                    )}
                    <span className="text-[color:var(--color-muted-foreground)]"> — {n.summary}</span>
                    {n.sourceUrl && (
                      <>
                        {' '}
                        <a
                          href={n.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-[color:var(--color-muted-foreground)] hover:underline"
                        >
                          ↗ source ({n.source})
                        </a>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

/**
 * Per-section error isolator. Same pattern as the intelligence
 * dashboard — one query failure shouldn't blank the whole page.
 */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error('[competitors] query failed:', err);
    return null;
  }
}

function Kpi({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: 'down' | 'up';
}) {
  const accentCls =
    accent === 'down'
      ? 'text-red-700'
      : accent === 'up'
        ? 'text-emerald-700'
        : '';
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 shadow-sm">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${accentCls}`}>{value}</div>
      {sub && (
        <div className="mt-0.5 text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>
      )}
    </div>
  );
}

function FilterChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  const base =
    'rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium';
  const cls = active
    ? `${base} border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]`
    : `${base} border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]`;
  return (
    <Link href={href} className={cls}>
      {label}
    </Link>
  );
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}
