import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import { listAiSpendThisMonth } from '../../lib/tenant-queries';

export default async function UsagePage() {
  const rows = await listAiSpendThisMonth();
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);

  return (
    <AdminShell title="AI usage">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <header className="mb-6">
          <h2 className="text-lg font-semibold">AI spend this month</h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {usd(total)} across {rows.length} tenants · {totalCalls.toLocaleString()} calls
          </p>
        </header>

        {rows.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No AI usage recorded this month.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Tenant</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Spend</th>
                  <th className="px-3 py-2 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.companyId} className="border-t border-[color:var(--color-border)]/60">
                    <td className="px-3 py-2">
                      <Link
                        href={`/tenants/${r.companyId}`}
                        className="font-medium text-[color:var(--color-foreground)] hover:underline"
                      >
                        {r.companyName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.calls.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {usd(r.cents)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {total > 0 ? `${Math.round((r.cents / total) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function usd(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
