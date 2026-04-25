import { AdminShell } from '../components/shell/AdminShell';
import { listTenants, listAiSpendThisMonth } from '../lib/tenant-queries';

export default async function AdminOverviewPage() {
  const [tenants, spend] = await Promise.all([listTenants(), listAiSpendThisMonth()]);

  const totalUsers = tenants.reduce((s, t) => s + t.userCount, 0);
  const totalPursuits = tenants.reduce((s, t) => s + t.pursuitCount, 0);
  const totalProposals = tenants.reduce((s, t) => s + t.proposalCount, 0);
  const totalContracts = tenants.reduce((s, t) => s + t.contractCount, 0);
  const totalCostCents = spend.reduce((s, r) => s + r.cents, 0);

  return (
    <AdminShell title="Overview">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Platform totals
        </h2>
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Tenants" value={tenants.length.toString()} />
          <Stat label="Users" value={totalUsers.toString()} />
          <Stat label="Pursuits" value={totalPursuits.toString()} />
          <Stat label="Proposals" value={totalProposals.toString()} />
          <Stat label="Contracts" value={totalContracts.toString()} />
        </section>

        <section className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            AI spend this month
          </p>
          <p className="mt-0.5 text-2xl font-semibold">{usd(totalCostCents)}</p>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Across {spend.length} active tenants. Top 3:
          </p>
          <ul className="mt-2 space-y-0.5 text-xs">
            {spend.slice(0, 3).map((r) => (
              <li key={r.companyId} className="flex justify-between gap-2">
                <span className="truncate">{r.companyName}</span>
                <span className="font-mono text-[color:var(--color-muted-foreground)]">
                  {usd(r.cents)} · {r.calls} calls
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-semibold">{value}</p>
    </div>
  );
}

function usd(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
