import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  countProbesNeedingCole,
  listMarketPortfolioRows,
  type PortfolioRow,
  type PortfolioSignalLevel,
} from '@procur/catalog';
import { CopyMarkdownToolbar } from '../_components/CopyMarkdownToolbar';
import {
  autopilotSendBatchAction,
  setProbeStatusAction,
  setProbeTierAction,
} from '../market-probes/actions';
import { formatPortfolioMarkdown } from './_lib/markdown';

export const dynamic = 'force-dynamic';

const SIGNAL_TONE: Record<PortfolioSignalLevel, string> = {
  early: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]',
  weak: 'bg-yellow-100 text-yellow-900',
  promising: 'bg-blue-100 text-blue-900',
  winning: 'bg-green-100 text-green-900',
  risky: 'bg-red-100 text-red-900',
};

const STATUS_TONE: Record<string, string> = {
  active: 'bg-green-100 text-green-900',
  planning: 'bg-amber-100 text-amber-900',
  paused: 'bg-amber-100 text-amber-900',
};

export default async function MarketPortfolioPage() {
  await requireCompany();
  const rows = await listMarketPortfolioRows();
  const needsCount = countProbesNeedingCole(rows);
  const markdown = formatPortfolioMarkdown(rows);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Market Portfolio
        </h1>
        <span className="text-sm text-[color:var(--color-muted-foreground)]">
          {rows.length} active / planning probe{rows.length === 1 ? '' : 's'}
        </span>
        {needsCount > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {needsCount} need{needsCount === 1 ? 's' : ''} Cole
          </span>
        )}
        <Link
          href="/market-probes"
          className="ml-auto text-sm text-[color:var(--color-muted-foreground)] hover:underline"
        >
          All probes (incl. completed) →
        </Link>
      </div>

      <CopyMarkdownToolbar markdown={markdown} slug="market-portfolio" />

      {/* Needs-Cole queue */}
      {needsCount > 0 && (
        <NeedsColeQueue rows={rows.filter((r) => r.needsColeReasons.length > 0)} />
      )}

      {/* Per-probe rows */}
      {rows.length === 0 ? (
        <p className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No active or planning probes. Visit{' '}
          <Link href="/market-probes" className="hover:underline">
            Market Probes
          </Link>{' '}
          to create one.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <ProbeCard key={r.id} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function NeedsColeQueue({ rows }: { rows: PortfolioRow[] }) {
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-amber-300 bg-amber-50 p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-900">
        Needs Cole ({rows.length})
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="text-sm">
            <Link
              href={`/market-probes/${r.id}/overview`}
              className="font-medium text-amber-900 hover:underline"
            >
              {r.marketName}
            </Link>
            <span className="text-amber-800">
              {' — '}
              {r.needsColeReasons.join('; ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProbeCard({ row }: { row: PortfolioRow }) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <Link
          href={`/market-probes/${row.id}/overview`}
          className="text-base font-semibold hover:underline"
        >
          {row.marketName}
        </Link>
        {row.country && (
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[11px] font-mono">
            {row.country.toUpperCase()}
          </span>
        )}
        {row.domain && (
          <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[11px]">
            {row.domain}
          </span>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            STATUS_TONE[row.status] ?? 'bg-[color:var(--color-muted)]/60'
          }`}
        >
          {row.status}
        </span>
        <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[11px]">
          Tier {row.tier}
        </span>
        <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] font-mono">
          {row.ladderStage}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SIGNAL_TONE[row.signalLevel]}`}
          title="Signal: early / weak / promising / winning / risky"
        >
          {row.signalLevel}
        </span>
        <span className="ml-auto text-[11px] text-[color:var(--color-muted-foreground)]">
          {row.allowedChannels.join(' · ')}
        </span>
      </div>

      <p className="mb-3 text-sm text-[color:var(--color-foreground)]">
        {row.recommendation}
      </p>

      {/* Metrics grid */}
      <div className="mb-3 grid grid-cols-2 gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-xs md:grid-cols-4 lg:grid-cols-6">
        <Metric
          label="Sent today"
          value={`${row.sentToday}/${row.dailySendLimit}`}
        />
        <Metric
          label="Total sent"
          value={`${row.totalSent}/${row.totalSendLimit}`}
        />
        <Metric label="Replies" value={String(row.replies)} sub={`${row.routingReplies} routing · ${row.positiveReplies} positive`} />
        <Metric label="Bounced" value={String(row.bounced)} warn={row.bounced > 0} />
        <Metric label="Unsubs" value={String(row.unsubscribed)} warn={row.unsubscribed > 0} />
        <Metric label="Learning" value={`${row.overallLearningScore}/100`} sub={`risk ${row.riskCleanlinessScore}`} />
      </div>

      {/* Channel breakdown */}
      <div className="mb-3 grid grid-cols-3 gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-[11px] text-[color:var(--color-muted-foreground)]">
        <span>email attempts: <strong className="text-[color:var(--color-foreground)]">{row.emailSent}</strong></span>
        <span>lead_form: <strong className="text-[color:var(--color-foreground)]">{row.leadFormsSubmitted}</strong></span>
        <span>rvm: <strong className="text-[color:var(--color-foreground)]">{row.rvmDispatched}</strong></span>
      </div>

      {/* Skip-reason breakdown — not yet tracked structurally */}
      <p className="mb-3 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Skip-reason breakdown (no-channel / no-recipient / no-form / no-phone /
        no-audio) not yet captured structurally; lands in autopilot return
        values today. Tracking PR pending.
      </p>

      {/* Needs-Cole reasons inline */}
      {row.needsColeReasons.length > 0 && (
        <div className="mb-3 rounded-[var(--radius-sm)] bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          {row.needsColeReasons.map((reason, i) => (
            <div key={i}>• {reason}</div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <ActionLink href={`/market-probes/${row.id}/overview`} label="Open" />
        <ActionLink
          href={`/market-probes/${row.id}/communications`}
          label="Communications"
          sub={false}
        />
        <ActionLink
          href={`/market-probes/${row.id}/settings`}
          label="Settings"
          sub={false}
        />
        <span className="ml-2 text-[color:var(--color-muted-foreground)]">·</span>
        {row.status === 'active' && (
          <StatusButton probeId={row.id} status="paused" label="Pause" />
        )}
        {row.status === 'paused' && (
          <StatusButton probeId={row.id} status="active" label="Resume" />
        )}
        <StatusButton probeId={row.id} status="completed" label="Mark completed" />
        <span className="ml-2 text-[color:var(--color-muted-foreground)]">·</span>
        {row.tier === 0 && row.mode === 'experiment' && (
          <TierButton probeId={row.id} tier={1} label="Graduate to Tier 1" />
        )}
        {row.tier >= 1 && (
          <TierButton probeId={row.id} tier={0} label="Demote to Tier 0" />
        )}
        {row.tier >= 1 && row.status === 'active' && row.mode === 'experiment' && (
          <RunBatchButton probeId={row.id} />
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <span
        className={`text-base font-semibold ${warn ? 'text-red-700' : ''}`}
      >
        {value}
      </span>
      {sub && (
        <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
          {sub}
        </span>
      )}
    </div>
  );
}

function ActionLink({
  href,
  label,
  sub,
}: {
  href: string;
  label: string;
  sub?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        sub === false
          ? 'rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 hover:bg-[color:var(--color-muted)]/40'
          : 'rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-0.5 font-medium text-[color:var(--color-background)] hover:opacity-90'
      }
    >
      {label}
    </Link>
  );
}

function StatusButton({
  probeId,
  status,
  label,
}: {
  probeId: string;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  label: string;
}) {
  return (
    <form action={setProbeStatusAction}>
      <input type="hidden" name="probeId" value={probeId} />
      <input type="hidden" name="status" value={status} />
      <button
        type="submit"
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 hover:bg-[color:var(--color-muted)]/40"
      >
        {label}
      </button>
    </form>
  );
}

function TierButton({
  probeId,
  tier,
  label,
}: {
  probeId: string;
  tier: number;
  label: string;
}) {
  return (
    <form action={setProbeTierAction}>
      <input type="hidden" name="probeId" value={probeId} />
      <input type="hidden" name="tier" value={String(tier)} />
      <button
        type="submit"
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 hover:bg-[color:var(--color-muted)]/40"
      >
        {label}
      </button>
    </form>
  );
}

function RunBatchButton({ probeId }: { probeId: string }) {
  return (
    <form action={autopilotSendBatchAction}>
      <input type="hidden" name="probeId" value={probeId} />
      <button
        type="submit"
        className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-0.5 font-medium text-[color:var(--color-background)] hover:opacity-90"
        title="Drafts + dispatches the next eligible batch within daily caps."
      >
        Run autopilot batch
      </button>
    </form>
  );
}
