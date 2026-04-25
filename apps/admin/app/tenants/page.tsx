import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import { listTenants, type TenantListRow } from '../../lib/tenant-queries';

const PLANS = ['free', 'pro', 'team', 'enterprise'] as const;

type SearchParams = {
  q?: string;
  plan?: string;
};

export default async function TenantsListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const planFilter =
    sp.plan && (PLANS as readonly string[]).includes(sp.plan) ? sp.plan : null;

  const allTenants = await listTenants();

  const needle = q.toLowerCase();
  const tenants = allTenants.filter((t) => {
    if (planFilter && t.planTier !== planFilter) return false;
    if (needle.length > 0) {
      const haystack = [t.name, t.country, t.id].filter(Boolean).join('  ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return (
    <AdminShell title="Tenants">
      <div className="mx-auto max-w-6xl px-8 py-10">
        <header className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-lg font-semibold">All tenants</h2>
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              {tenants.length === allTenants.length
                ? `${allTenants.length} companies, sorted newest first.`
                : `${tenants.length} of ${allTenants.length} matching filters.`}
            </p>
          </div>
        </header>

        <form
          method="GET"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-2 text-xs"
        >
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search by tenant name, country, or company ID…"
            className="min-w-[14rem] flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
          <label className="flex items-center gap-1">
            <span className="text-[color:var(--color-muted-foreground)]">Plan:</span>
            <select
              name="plan"
              defaultValue={planFilter ?? ''}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 capitalize"
            >
              <option value="">Any</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1"
          >
            Apply
          </button>
          {(q || planFilter) && (
            <Link
              href="/tenants"
              className="text-[color:var(--color-muted-foreground)] hover:underline"
            >
              Clear
            </Link>
          )}
        </form>

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
              {tenants.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-10 text-center text-xs text-[color:var(--color-muted-foreground)]"
                  >
                    No tenants match these filters.{' '}
                    <Link href="/tenants" className="underline">
                      Clear
                    </Link>
                  </td>
                </tr>
              ) : (
                tenants.map((t) => (
                  <Row key={t.id} t={t} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}

function Row({ t }: { t: TenantListRow }) {
  return (
    <tr className="border-t border-[color:var(--color-border)]/60">
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
      <td className="px-3 py-2 text-right font-mono text-xs">{usd(t.costCentsThisMonth)}</td>
      <td className="px-3 py-2 text-[11px] text-[color:var(--color-muted-foreground)]">
        {t.createdAt.toLocaleDateString()}
      </td>
    </tr>
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
