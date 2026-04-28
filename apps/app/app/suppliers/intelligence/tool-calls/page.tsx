import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { getToolCallStats } from '@procur/catalog';

/**
 * Tool-call analytics — adoption + coverage-gap signals for the
 * supplier-graph assistant tools (and any other tool wired into
 * tool_call_logs via withToolTelemetry).
 *
 * Server component, companyId-scoped via requireCompany().
 */
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ days?: string }>;
}

export default async function ToolCallStatsPage({ searchParams }: Props) {
  const { days } = await searchParams;
  const daysLookback = days ? Number.parseInt(days, 10) : 30;

  const { company } = await requireCompany();
  const stats = await getToolCallStats(company.id, daysLookback);

  const totalCalls = stats.reduce((s, r) => s + r.totalCalls, 0);
  const overallZeroRate =
    totalCalls > 0
      ? stats.reduce((s, r) => s + r.zeroResultCalls, 0) / totalCalls
      : 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link
          href="/suppliers/intelligence"
          className="hover:text-[color:var(--color-foreground)]"
        >
          ← Intelligence
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Tool-call analytics</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Per-tool adoption, zero-result rates, and latency over the last{' '}
          <span className="font-medium">{daysLookback} days</span>.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[color:var(--color-muted-foreground)]">Window:</span>
        {[7, 30, 90].map((d) => (
          <Link
            key={d}
            href={`/suppliers/intelligence/tool-calls?days=${d}`}
            className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
              daysLookback === d
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                : 'border-[color:var(--color-border)]'
            }`}
          >
            {d}d
          </Link>
        ))}
      </div>

      {stats.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No tool calls logged in this window. Either no one has used the assistant for a tool-
          requiring query yet, or the telemetry wrapper isn&apos;t wired into the tools you&apos;ve
          been calling.
        </div>
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Total calls" value={totalCalls.toLocaleString()} />
            <Stat
              label="Distinct tools"
              value={stats.length.toLocaleString()}
            />
            <Stat
              label="Zero-result rate"
              value={`${Math.round(overallZeroRate * 100)}%`}
            />
          </section>

          <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                <tr>
                  <Th>Tool</Th>
                  <Th>Calls</Th>
                  <Th>Zero-result</Th>
                  <Th>Errors</Th>
                  <Th>Avg latency</Th>
                  <Th>p95 latency</Th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => {
                  const zeroPct =
                    s.totalCalls > 0
                      ? Math.round((s.zeroResultCalls / s.totalCalls) * 100)
                      : 0;
                  const errPct =
                    s.totalCalls > 0
                      ? Math.round((s.errorCalls / s.totalCalls) * 100)
                      : 0;
                  return (
                    <tr
                      key={s.toolName}
                      className="border-b border-[color:var(--color-border)] last:border-b-0"
                    >
                      <Td>
                        <code className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 px-1.5 py-0.5 text-xs">
                          {s.toolName}
                        </code>
                      </Td>
                      <Td className="tabular-nums">{s.totalCalls.toLocaleString()}</Td>
                      <Td className="tabular-nums">
                        {s.zeroResultCalls} <span className="text-[color:var(--color-muted-foreground)]">({zeroPct}%)</span>
                      </Td>
                      <Td className="tabular-nums">
                        {s.errorCalls > 0 ? (
                          <span className="text-red-700">
                            {s.errorCalls} ({errPct}%)
                          </span>
                        ) : (
                          <span className="text-[color:var(--color-muted-foreground)]">0</span>
                        )}
                      </Td>
                      <Td className="tabular-nums">{s.avgLatencyMs}ms</Td>
                      <Td className="tabular-nums">{s.p95LatencyMs}ms</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Source: tool_call_logs (logged via withToolTelemetry from @procur/ai). Currently wired into
        find_buyers_for_offer, find_suppliers_for_tender, analyze_supplier. Other tools follow as
        the analytics surface matures.
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className ?? ''}`}>{children}</td>;
}
