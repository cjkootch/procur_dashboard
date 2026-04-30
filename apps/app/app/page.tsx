import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { getCurrentCompany, getCurrentUser } from '@procur/auth';
import { alertProfiles, db } from '@procur/db';
import {
  getMatchQueue,
  listEntityNews,
  listOpportunities,
  type EntityNewsRow,
} from '@procur/catalog';
import { AppShell } from '../components/shell/AppShell';
import { CommodityPriceTicker } from '../components/CommodityPriceTicker';
import { formatDate, formatMoney } from '../lib/format';

export const dynamic = 'force-dynamic';

/**
 * Daily-driver Brief. Replaces the previous welcome dashboard with a
 * tight 4-card surface answering "what should I look at right now?":
 *
 *   1. Match queue       — operator-curated supplier signals
 *   2. Active deals      — pointer into vex (deals live there)
 *   3. New tenders       — opps published in last 24h matching bid criteria
 *   4. Entity proposals  — chat-emitted propose_create/update awaiting approval
 *
 * Section #4 is currently a placeholder; a `pending_entity_proposals`
 * table doesn't exist yet — the model emits proposal cards inline in
 * chat and the user clicks Apply there. Surfacing them here is a
 * follow-up once the queue is persisted.
 */
export default async function BriefPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const company = await getCurrentCompany();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'there';

  if (!company) {
    return (
      <AppShell title="Brief">
        <div className="mx-auto max-w-3xl px-4 py-12 md:px-6">
          <p className="text-base text-[color:var(--color-muted-foreground)]">
            Welcome, {displayName}.{' '}
            <Link className="text-[color:var(--color-accent)] underline" href="/onboarding">
              Complete onboarding to create your organization
            </Link>
            .
          </p>
        </div>
      </AppShell>
    );
  }

  // Pull the user's first active alert profile so the Tenders card can
  // narrow to their actual bid criteria. If none, the card shifts to a
  // "Configure bid criteria" CTA instead of dumping every recent opp.
  const alertProfile = await db.query.alertProfiles.findFirst({
    where: and(
      eq(alertProfiles.userId, user.id),
      eq(alertProfiles.companyId, company.id),
      eq(alertProfiles.active, true),
    ),
    orderBy: desc(alertProfiles.createdAt),
  });

  // 24h cutoff for "new tenders" — anything published in the last day.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [matchQueueItems, recentOpps, counterpartyNews, fuelMarketNews] =
    await Promise.all([
      getMatchQueue({ status: 'open', daysBack: 7, limit: 100 }),
      alertProfile
        ? listOpportunities({
            // OpportunityFilters takes single values, so pick the first
            // jurisdiction/category from the profile; client-side filter
            // below tightens the rest. Approximate but ships v1.
            jurisdiction: alertProfile.jurisdictions?.[0],
            category: alertProfile.categories?.[0],
            publishedAfter: dayAgo,
            scope: 'open',
            sort: 'recent',
            perPage: 25,
          })
        : Promise.resolve({ rows: [], total: 0 }),
      // Counterparty news — last 7d, only on approved suppliers, only
      // medium+ relevance. Empty until the cron has run a few cycles
      // and the user has at least one approved supplier; the panel
      // renders nothing in that case rather than showing a stale
      // placeholder.
      listEntityNews({
        approvedSuppliersOnly: true,
        companyId: company.id,
        eventTypes: ['press_distress_signal'],
        minRelevance: 0.5,
        daysBack: 7,
        limit: 12,
      }).catch(() => [] as EntityNewsRow[]),
      // Fuel-market news — last 3d, all entities, eventType=
      // fuel_market_news. Higher relevance bar (0.6) since this
      // panel doesn't filter by approval scope and we don't want
      // the stream to drown the brief.
      listEntityNews({
        eventTypes: ['fuel_market_news'],
        minRelevance: 0.6,
        daysBack: 3,
        limit: 8,
      }).catch(() => [] as EntityNewsRow[]),
    ]);

  // Client-side narrow on the rest of the alert-profile filters
  // (additional jurisdictions/categories beyond the first, plus
  // keyword matching). Cheap because perPage is capped at 25.
  const profileJurs = alertProfile?.jurisdictions ?? null;
  const profileCats = alertProfile?.categories ?? null;
  const newTenders = recentOpps.rows.filter((o) => {
    if (profileJurs && profileJurs.length > 0 && !profileJurs.includes(o.jurisdictionSlug)) {
      return false;
    }
    if (profileCats && profileCats.length > 0 && o.category && !profileCats.includes(o.category)) {
      return false;
    }
    return true;
  });

  return (
    <AppShell title="">
      <div className="px-4 py-6 md:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            Good morning, {user.firstName ?? 'there'}.
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Here&apos;s what changed overnight.
          </p>
        </header>

        {/* Live commodity ticker — same five series the market
            intelligence page surfaces. Renders nothing if the
            benchmark fetch fails so a transient error doesn't
            blank the morning brief. */}
        <CommodityPriceTicker />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BriefCard
            title="Match queue"
            count={matchQueueItems.length}
            countLabel={matchQueueItems.length === 1 ? 'signal' : 'signals'}
            href="/suppliers/match-queue"
            ctaLabel="Open match queue"
            empty="No new signals in the last 7 days."
          >
            {matchQueueItems.slice(0, 3).map((item) => (
              <Link
                key={item.id}
                href={
                  item.entityProfileSlug
                    ? `/entities/${item.entityProfileSlug}`
                    : '/suppliers/match-queue'
                }
                className="block rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 transition hover:border-[color:var(--color-foreground)]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-medium">{item.sourceEntityName}</p>
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                    {item.signalType.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-[color:var(--color-muted-foreground)]">
                  {item.rationale}
                </p>
              </Link>
            ))}
          </BriefCard>

          <BriefCard
            title="Active deals"
            iconSrc="/brand/vex-icon-on-light.svg"
            count={null}
            href="https://app.vexhq.ai"
            external
            ctaLabel="Open vex"
            empty="Deals live in vex — open the CRM to act on candidates pushed from procur."
          >
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              Once you push entities to vex from the rolodex or chat, they appear in vex&apos;s
              origination queue with the chat-summary context attached.
            </p>
          </BriefCard>

          <BriefCard
            title="New tenders"
            count={alertProfile ? newTenders.length : null}
            countLabel={newTenders.length === 1 ? 'tender' : 'tenders'}
            href={alertProfile ? '/alerts' : '/alerts/new'}
            ctaLabel={alertProfile ? 'View all alerts' : 'Configure bid criteria'}
            empty={
              alertProfile
                ? 'No new tenders matching your criteria in the last 24 hours.'
                : 'Configure a bid-criteria alert profile to surface matching tenders here.'
            }
          >
            {alertProfile &&
              newTenders.slice(0, 3).map((opp) => (
                <Link
                  key={opp.id}
                  href={`/discover/${opp.slug}`}
                  className="block rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-2 transition hover:border-[color:var(--color-foreground)]"
                >
                  <p className="truncate text-sm font-medium">{opp.title}</p>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-[color:var(--color-muted-foreground)]">
                    <span>{opp.jurisdictionName}</span>
                    {opp.valueEstimateUsd && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatMoney(opp.valueEstimateUsd, 'USD')}</span>
                      </>
                    )}
                    {opp.deadlineAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>Due {formatDate(opp.deadlineAt)}</span>
                      </>
                    )}
                  </div>
                </Link>
              ))}
          </BriefCard>

          <BriefCard
            title="Entity proposals"
            count={null}
            href="/assistant"
            ctaLabel="Open assistant"
            empty="Proposals from chat (propose_create / propose_update) appear here once the approval queue lands. Today they live inline in chat — click Apply on the card to commit."
          />
        </div>

        {counterpartyNews.length > 0 && (
          <CounterpartyNewsPanel news={counterpartyNews} />
        )}

        {fuelMarketNews.length > 0 && (
          <FuelMarketNewsPanel news={fuelMarketNews} />
        )}
      </div>
    </AppShell>
  );
}

/**
 * Fuel-market news panel — broader feed than the counterparty one.
 * Captures Brent moves with named drivers, OPEC+ decisions,
 * refining margins, freight rate moves, sanctions changes, and
 * geopolitical events with fuel-market consequences. Items don't
 * have to mention an approved supplier to surface.
 *
 * Sits below the counterparty panel because counterparty news is
 * higher-leverage when present (it's about deals you're working
 * RIGHT NOW); fuel-market news is the broader context that helps
 * sense-check pricing and timing.
 */
function FuelMarketNewsPanel({ news }: { news: EntityNewsRow[] }) {
  return (
    <section className="mt-6">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-foreground)]">
          Fuel market
        </h2>
        <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
          Broader market context · last 3 days
        </span>
      </header>
      <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
        {news.map((n) => (
          <li key={n.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="inline-flex shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900">
                Market
              </span>
              <span className="ml-auto text-[11px] text-[color:var(--color-muted-foreground)]">
                {formatDate(new Date(n.eventDate))} · {n.source}
              </span>
            </div>
            <p className="mt-1 text-sm font-medium">{n.entityName}</p>
            <p className="mt-1 text-sm text-[color:var(--color-foreground)]/85">
              {n.summary}
            </p>
            {n.sourceUrl && (
              <div className="mt-1 text-[11px]">
                <a
                  href={n.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
                >
                  Read source →
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * News on the company's approved suppliers from the last 7 days,
 * sourced from the RSS-ingest task in services/ai-pipeline. Renders
 * a tight one-row-per-event list with event-type pill, entity link,
 * relative date, and an external link to the source.
 */
function CounterpartyNewsPanel({ news }: { news: EntityNewsRow[] }) {
  return (
    <section className="mt-8">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-foreground)]">
          Counterparty news
        </h2>
        <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
          Approved suppliers · last 7 days · auto-ingested every 4h
        </span>
      </header>
      <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
        {news.map((n) => (
          <li key={n.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <EventTypePill kind={n.eventType} />
              {n.entitySlug ? (
                <Link
                  href={`/entities/${encodeURIComponent(n.entitySlug)}`}
                  className="text-sm font-medium hover:underline"
                >
                  {n.entityName}
                </Link>
              ) : (
                <span className="text-sm font-medium">{n.entityName}</span>
              )}
              {n.entityCountry && (
                <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                  · {n.entityCountry}
                </span>
              )}
              <span className="ml-auto text-[11px] text-[color:var(--color-muted-foreground)]">
                {formatDate(new Date(n.eventDate))} · {n.source}
              </span>
            </div>
            <p className="mt-1 text-sm text-[color:var(--color-foreground)]/85">
              {n.summary}
            </p>
            {n.sourceUrl && (
              <div className="mt-1 text-[11px]">
                <a
                  href={n.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
                >
                  Read source →
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const EVENT_TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  refinery_outage: {
    label: 'Outage',
    cls: 'bg-red-100 text-red-900',
  },
  refinery_turnaround: {
    label: 'Turnaround',
    cls: 'bg-amber-100 text-amber-900',
  },
  sanctions_action: {
    label: 'Sanctions',
    cls: 'bg-red-100 text-red-900',
  },
  bankruptcy_filing: {
    label: 'Bankruptcy',
    cls: 'bg-red-100 text-red-900',
  },
  leadership_change: {
    label: 'Leadership',
    cls: 'bg-sky-100 text-sky-900',
  },
  force_majeure: {
    label: 'Force majeure',
    cls: 'bg-orange-100 text-orange-900',
  },
  pipeline_disruption: {
    label: 'Pipeline',
    cls: 'bg-orange-100 text-orange-900',
  },
  port_disruption: {
    label: 'Port',
    cls: 'bg-orange-100 text-orange-900',
  },
  mna_announcement: {
    label: 'M&A',
    cls: 'bg-violet-100 text-violet-900',
  },
  capacity_change: {
    label: 'Capacity',
    cls: 'bg-sky-100 text-sky-900',
  },
  press_distress_signal: {
    label: 'Distress',
    cls: 'bg-amber-100 text-amber-900',
  },
  price_event: {
    label: 'Price',
    cls: 'bg-slate-100 text-slate-900',
  },
  general_news: {
    label: 'News',
    cls: 'bg-slate-100 text-slate-900',
  },
};

function EventTypePill({ kind }: { kind: string }) {
  const spec = EVENT_TYPE_LABEL[kind] ?? EVENT_TYPE_LABEL.general_news!;
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${spec.cls}`}
    >
      {spec.label}
    </span>
  );
}

function BriefCard({
  title,
  iconSrc,
  count,
  countLabel,
  href,
  external,
  ctaLabel,
  empty,
  children,
}: {
  title: string;
  /** Optional brand icon shown next to the title. Currently used by
   *  the "Active deals" card to visually mark it as the vex surface. */
  iconSrc?: string;
  count: number | null;
  countLabel?: string;
  href: string;
  external?: boolean;
  ctaLabel: string;
  empty: string;
  children?: React.ReactNode;
}) {
  const hasItems = Array.isArray((children as { props?: unknown }[] | undefined))
    ? ((children as { props?: unknown }[]).length > 0)
    : children != null && children !== false;

  return (
    <section
      className="flex flex-col rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4"
      style={{ boxShadow: 'var(--shadow-sm)' }}
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {iconSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconSrc} alt="" aria-hidden className="h-4 w-4" />
          )}
          {title}
        </h2>
        {count != null && (
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            {count} {countLabel ?? 'items'}
          </span>
        )}
      </header>
      <div className="flex flex-1 flex-col gap-2">
        {hasItems ? (
          children
        ) : (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">{empty}</p>
        )}
      </div>
      <div className="mt-3 pt-3">
        {external ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
          >
            {ctaLabel} →
          </a>
        ) : (
          <Link
            href={href}
            className="text-xs font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
          >
            {ctaLabel} →
          </Link>
        )}
      </div>
    </section>
  );
}
