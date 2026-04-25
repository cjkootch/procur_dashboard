import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import { listTenants } from '../../lib/tenant-queries';

export default async function TenantsListPage() {
  const tenants = await listTenants();

  return (
    <AdminShell title="Tenants">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <header className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-lg font-semibold">All tenants</h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              {tenants.length} companies, sorted newest first.
            </p>
          </div>
        </header>

        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-3 py-2 font-medium">Tenant</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 font-medium">Country</th>
                <th className="px-3 py-2 text-right font-medium">Users</th>
                <th className="px-3 py-2 text-right font-medium">Pursuits</th>
                <th className="px-3 py-2 text-right font-medium">Proposals</th>
                <th className="px-3 py-2 text-right font-medium">Contracts</th>
                <th className="px-3 py-2 text-right font-medium">AI / mo</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-t border-[color:var(--color-border)]/60">
                  <td className="px-3 py-2">
                    <Link
                      href={`/tenants/${t.id}`}
                      className="font-medium text-[color:var(--color-foreground)] hover:underline"
                    >
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">{t.planTier}</td>
                  <td className="px-3 py-2 text-xs">{t.country ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.userCount}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.pursuitCount}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.proposalCount}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{t.contractCount}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {usd(t.costCentsThisMonth)}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-[color:var(--color-muted-foreground)]">
                    {t.createdAt.toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}

function usd(cents: number): string {
  if (cents === 0) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
