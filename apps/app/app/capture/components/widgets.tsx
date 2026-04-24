import Link from 'next/link';
import type { DashboardData } from '../../../lib/capture-queries';
import { STAGE_LABEL } from '../../../lib/capture-queries';
import { formatMoney } from '../../../lib/format';

// -- Donut (no chart library) ------------------------------------------------

/**
 * Inline-SVG donut. Pure presentation, no client JS, no external lib.
 * `slices` must sum to a positive total or the donut is rendered blank.
 */
function Donut({
  slices,
  size = 96,
}: {
  slices: Array<{ value: number; color: string; label: string }>;
  size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const radius = size / 2 - 4;
  const stroke = 14;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <svg width={size} height={size} role="img" aria-label="No data">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={stroke}
        />
      </svg>
    );
  }

  let offset = 0;
  return (
    <svg width={size} height={size} role="img" aria-label="Tasks by status">
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={stroke}
      />
      {slices.map((s, i) => {
        if (s.value === 0) return null;
        const len = (s.value / total) * circumference;
        const dasharray = `${len} ${circumference - len}`;
        const dashoffset = -offset;
        offset += len;
        return (
          <circle
            key={i}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={s.color}
            strokeWidth={stroke}
            strokeDasharray={dasharray}
            strokeDashoffset={dashoffset}
            transform={`rotate(-90 ${center} ${center})`}
          >
            <title>
              {s.label}: {s.value}
            </title>
          </circle>
        );
      })}
      <text
        x={center}
        y={center}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[color:var(--color-foreground)] text-base font-semibold"
      >
        {total}
      </text>
    </svg>
  );
}

// -- Tasks widget ------------------------------------------------------------

export function TasksWidget({ data }: { data: DashboardData['tasks'] }) {
  const slices = [
    { value: data.pending, color: '#f59e0b', label: 'Pending' },
    { value: data.inProgress, color: '#3b82f6', label: 'In Progress' },
    { value: data.completed, color: '#10b981', label: 'Completed' },
  ];
  const total = data.pending + data.inProgress + data.completed;
  return (
    <Widget title="Tasks">
      <div className="flex items-center gap-4">
        <Donut slices={slices} />
        <ul className="flex-1 space-y-1.5 text-xs">
          <LegendRow color="#f59e0b" label="Pending" value={data.pending} total={total} />
          <LegendRow color="#3b82f6" label="In Progress" value={data.inProgress} total={total} />
          <LegendRow color="#10b981" label="Completed" value={data.completed} total={total} />
        </ul>
      </div>
      {data.dueSoon.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            Due in next 30 days
          </h3>
          <ul className="mt-1.5 space-y-1 text-xs">
            {data.dueSoon.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-2">
                <Link
                  href={`/capture/pursuits/${t.pursuitId}`}
                  className="truncate hover:underline"
                  title={t.pursuitTitle}
                >
                  {t.title}
                </Link>
                <span className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]">
                  {t.dueDate}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Widget>
  );
}

function LegendRow({
  color,
  label,
  value,
  total,
}: {
  color: string;
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <li className="flex items-center gap-2">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="flex-1">{label}</span>
      <span className="font-medium">{value}</span>
      <span className="w-9 text-right text-[color:var(--color-muted-foreground)]">{pct}%</span>
    </li>
  );
}

// -- Capture-questions widget ------------------------------------------------

export function CaptureQuestionsWidget({
  data,
}: {
  data: DashboardData['captureQuestions'];
}) {
  const overallPct =
    data.activePursuits > 0
      ? Math.round((data.pursuitsWithAnyAnswer / data.activePursuits) * 100)
      : 0;
  return (
    <Widget title="My assigned capture questions">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-2xl font-semibold">
          {data.pursuitsWithAnyAnswer}
          <span className="text-sm font-normal text-[color:var(--color-muted-foreground)]">
            {' '}
            of {data.activePursuits} active
          </span>
        </p>
        <p className="text-sm font-medium">{overallPct}%</p>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-[color:var(--color-muted)]/50">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${overallPct}%` }}
        />
      </div>
      {data.myAssigned.length > 0 ? (
        <ul className="space-y-2">
          {data.myAssigned.map((p) => {
            const pct = Math.round((p.answeredCount / p.totalQuestions) * 100);
            return (
              <li key={p.pursuitId} className="text-xs">
                <Link
                  href={`/capture/pursuits/${p.pursuitId}/capture-questions`}
                  className="block hover:underline"
                >
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="truncate" title={p.pursuitTitle}>
                      {p.pursuitTitle}
                    </span>
                    <span className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)]">
                      {p.answeredCount}/{p.totalQuestions}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-[color:var(--color-muted)]/50">
                    <div
                      className={`h-full ${pct === 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-blue-500' : 'bg-amber-500'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          You have no active pursuits assigned.
        </p>
      )}
    </Widget>
  );
}

// -- Pipeline-by-value widget ------------------------------------------------

export function PipelineByValueWidget({
  data,
}: {
  data: DashboardData['pipelineByValueUsd'];
}) {
  // Skip closed-stage rows (awarded/lost) — pipeline view is for in-flight.
  const open = data.filter((r) => r.stage !== 'awarded' && r.stage !== 'lost');
  const max = Math.max(...open.map((r) => r.valueUsd), 1);
  const total = open.reduce((s, r) => s + r.valueUsd, 0);
  return (
    <Widget title="Pipeline by value">
      <p className="mb-3 text-2xl font-semibold">
        {formatMoney(total, 'USD') ?? '$0'}
        <span className="ml-1 text-xs font-normal text-[color:var(--color-muted-foreground)]">
          TCV
        </span>
      </p>
      <ul className="space-y-1.5 text-xs">
        {open.map((r) => (
          <li key={r.stage} className="flex items-center gap-2">
            <span className="w-32 truncate text-[color:var(--color-muted-foreground)]">
              {STAGE_LABEL[r.stage]}
            </span>
            <div className="flex-1">
              <div className="h-2 overflow-hidden rounded-full bg-[color:var(--color-muted)]/50">
                <div
                  className="h-full bg-blue-500"
                  style={{ width: `${(r.valueUsd / max) * 100}%` }}
                />
              </div>
            </div>
            <span className="w-16 text-right font-medium">
              {formatMoney(r.valueUsd, 'USD') ?? '—'}
            </span>
            <span className="w-7 text-right text-[10px] text-[color:var(--color-muted-foreground)]">
              {r.count}
            </span>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

// -- Active-opportunities widget ---------------------------------------------

export function ActiveOpportunitiesWidget({
  data,
}: {
  data: DashboardData['activeOpportunities'];
}) {
  const dueIn30Pct =
    data.activePursuits > 0 ? Math.round((data.dueIn30Days / data.activePursuits) * 100) : 0;
  return (
    <Widget title="Active opportunities">
      <div className="flex items-end gap-6">
        <div>
          <p className="text-3xl font-semibold">{data.activePursuits}</p>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">active</p>
        </div>
        <div>
          <p className="text-3xl font-semibold text-amber-600">{data.dueIn30Days}</p>
          <p className="text-xs text-[color:var(--color-muted-foreground)]">due in 30 days</p>
        </div>
      </div>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[color:var(--color-muted)]/50">
        <div className="h-full bg-amber-500" style={{ width: `${dueIn30Pct}%` }} />
      </div>
      <Link
        href="/capture/pipeline?sort=deadline"
        className="mt-3 inline-block text-xs underline"
      >
        View pipeline by deadline →
      </Link>
    </Widget>
  );
}

// -- Shared shell ------------------------------------------------------------

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </article>
  );
}
