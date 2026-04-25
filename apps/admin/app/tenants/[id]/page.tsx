import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AdminShell } from '../../../components/shell/AdminShell';
import { getTenantDetail } from '../../../lib/tenant-queries';
import { setTenantPlanTierAction } from './actions';

const PLAN_TIERS = ['free', 'pro', 'team', 'enterprise'] as const;

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getTenantDetail(id);
  if (!detail) notFound();
  const { company, members, counts, aiCostsThisMonth } = detail;
  const totalMonthCents = aiCostsThisMonth.reduce((s, r) => s + r.cents, 0);

  return (
    <AdminShell title={company.name}>
      <div className="mx-auto max-w-5xl px-8 py-10">
        <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          <Link href="/tenants" className="hover:underline">
            Tenants
          </Link>
          <span> / </span>
          <span className="text-[color:var(--color-foreground)]">{company.name}</span>
        </nav>

        <header className="mb-6">
          <h1 className="text-2xl font-semibold">{company.name}</h1>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            {company.country ?? '—'} · created{' '}
            {new Date(company.createdAt).toLocaleDateString()} · clerk org{' '}
            <span className="font-mono">{company.clerkOrgId ?? '—'}</span>
          </p>
        </header>

        <section className="mb-6 grid gap-3 sm:grid-cols-4">
          <Stat label="Users" value={members.length.toString()} />
          <Stat label="Pursuits" value={counts.pursuits.toString()} />
          <Stat label="Proposals" value={counts.proposals.toString()} />
          <Stat label="Contracts" value={counts.contracts.toString()} />
        </section>

        {/* Plan tier override */}
        <section className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
          <h2 className="text-sm font-semibold">Plan tier</h2>
          <p className="mt-1 mb-3 text-xs text-[color:var(--color-muted-foreground)]">
            Manual override. Audit-logged onto this tenant; the user app
            picks up the new tier on the next page load.
          </p>
          <form action={setTenantPlanTierAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="companyId" value={company.id} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                Tier
              </span>
              <select
                name="planTier"
                defaultValue={company.planTier}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm capitalize"
              >
                {PLAN_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
            >
              Apply
            </button>
          </form>
        </section>

        {/* AI spend */}
        <section className="mb-6 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
          <h2 className="mb-1 text-sm font-semibold">AI spend this month</h2>
          <p className="mb-3 text-2xl font-semibold">{usd(totalMonthCents)}</p>
          {aiCostsThisMonth.length === 0 ? (
            <p className="text-xs text-[color:var(--color-muted-foreground)]">
              No AI calls billed this month.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="pb-1.5 font-medium">Source</th>
                  <th className="pb-1.5 text-right font-medium">Calls</th>
                  <th className="pb-1.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {aiCostsThisMonth.map((r) => (
                  <tr key={r.source} className="border-t border-[color:var(--color-border)]/60">
                    <td className="py-1.5">{r.source}</td>
                    <td className="py-1.5 text-right font-mono">{r.calls}</td>
                    <td className="py-1.5 text-right font-mono">{usd(r.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Members */}
        <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
          <h2 className="mb-3 text-sm font-semibold">Members ({members.length})</h2>
          <ul className="divide-y divide-[color:var(--color-border)]/60">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium">
                    {[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}
                  </p>
                  <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {m.email}
                  </p>
                </div>
                <div className="text-right text-[11px] text-[color:var(--color-muted-foreground)]">
                  <p className="capitalize">{m.role}</p>
                  <p>joined {new Date(m.createdAt).toLocaleDateString()}</p>
                </div>
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
