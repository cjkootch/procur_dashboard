import Link from 'next/link';
import { getMatchQueue } from '@procur/catalog';
import { MatchRow } from './_components/MatchRow';

export const dynamic = 'force-dynamic';

/**
 * Daily match queue — proactive deal-origination signals to action.
 *
 * Rows come from score-match-queue (Trigger.dev daily 15:30 UTC):
 *   distress events from entity_news_events
 *   velocity drops from supplier_capability_summary
 *   fresh awards in target categories × target countries
 *
 * Layout: ranked list, score chip + signal-class badge + entity
 * link + rationale + per-row actions (push to vex, actioned,
 * dismiss). Filters: signal type + lookback. Status defaults to
 * 'open' — dismissed/actioned rows hide.
 *
 * Click "Push to vex" marks the row in procur; the actual push
 * happens via the assistant chat (propose_push_to_vex_contact tool
 * from PR #264). v2 will connect the button directly to that flow
 * — for now the button is a status-only marker so the queue
 * doesn't re-surface things you've already handled.
 */
interface Props {
  searchParams: Promise<{
    signal?: 'distress_event' | 'velocity_drop' | 'new_award';
    days?: string;
  }>;
}

export default async function MatchQueuePage({ searchParams }: Props) {
  const params = await searchParams;
  const days = clampDays(params.days);
  const items = await getMatchQueue({
    status: 'open',
    signalType: params.signal,
    daysBack: days,
    limit: 200,
  });

  const distressCount = items.filter((i) => i.signalType === 'distress_event').length;
  const velocityCount = items.filter((i) => i.signalType === 'velocity_drop').length;
  const awardCount = items.filter((i) => i.signalType === 'new_award').length;

  return (
    <div className="mx-auto max-w-7xl bg-[color:var(--color-muted)]/40 px-6 py-6 min-h-[calc(100vh-49px)]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Match queue</h1>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Today&apos;s ranked deal-origination signals across the whole VTC lane: distress events
          (SEC EDGAR / RECAP / RSS), velocity drops in award flow, fresh procurement awards in
          target categories × countries. Click &quot;Push to vex&quot; to forward the lead with
          full commercial context — vex&apos;s CRM record opens in a new tab on success.
        </p>
      </header>

      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Open" value={items.length.toString()} sub={`${days}-day window`} />
        <Kpi label="Distress" value={distressCount.toString()} sub="news events + EDGAR + RECAP" />
        <Kpi label="Velocity" value={velocityCount.toString()} sub="awards down 50%+ vs 90d prior" />
        <Kpi label="New awards" value={awardCount.toString()} sub="last 24h, target lane" />
      </section>

      <section className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Signal:
        </span>
        <Chip href={buildHref(params, { signal: undefined })} label="All" active={!params.signal} />
        <Chip
          href={buildHref(params, { signal: 'distress_event' })}
          label="Distress"
          active={params.signal === 'distress_event'}
        />
        <Chip
          href={buildHref(params, { signal: 'velocity_drop' })}
          label="Velocity drops"
          active={params.signal === 'velocity_drop'}
        />
        <Chip
          href={buildHref(params, { signal: 'new_award' })}
          label="New awards"
          active={params.signal === 'new_award'}
        />
        <span className="ml-3 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Window:
        </span>
        {[1, 7, 30].map((d) => (
          <Chip
            key={d}
            href={buildHref(params, { days: String(d) })}
            label={`${d}d`}
            active={days === d}
          />
        ))}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 shadow-sm">
        {items.length === 0 ? (
          <p className="py-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No open matches in the last {days} days. The scoring job runs daily at 15:30 UTC; ensure
            entity_news_events / supplier_capability_summary / awards have been refreshed since the
            last cron pass.
          </p>
        ) : (
          <ul>
            {items.map((it) => (
              <MatchRow key={it.id} {...it} />
            ))}
          </ul>
        )}
      </section>

      <p className="mt-3 text-[10px] text-[color:var(--color-muted-foreground)]">
        Source: <Link href="/suppliers/intelligence" className="underline">Market intelligence</Link>{' '}
        + <Link href="/suppliers/competitors" className="underline">Competitors</Link> + AIS-derived
        cargo flows. Scoring composes signal-class baseline + recency bonus; capped at 9.99.
      </p>
    </div>
  );
}

function clampDays(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 90) return 7;
  return n;
}

function buildHref(
  current: { signal?: string; days?: string },
  override: { signal?: string; days?: string },
): string {
  const next = { ...current, ...override };
  const sp = new URLSearchParams();
  if (next.signal) sp.set('signal', next.signal);
  if (next.days) sp.set('days', next.days);
  const qs = sp.toString();
  return `/suppliers/match-queue${qs ? `?${qs}` : ''}`;
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 shadow-sm">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>
    </div>
  );
}

function Chip({ href, label, active }: { href: string; label: string; active: boolean }) {
  const base = 'rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium';
  const cls = active
    ? `${base} border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]`
    : `${base} border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]`;
  return (
    <Link href={href} className={cls}>
      {label}
    </Link>
  );
}
