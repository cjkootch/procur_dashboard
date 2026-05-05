import type { ApolloEntityCache } from '@procur/catalog';
import { RefreshApolloButton } from './RefreshApolloButton';

/**
 * "Corporate context" panel on the entity profile, sourced from the
 * cached Apollo org snapshot. Renders empty-state gracefully when the
 * entity has no Apollo match yet (cache = null).
 *
 * Refresh button calls the server action which invokes
 * enrichOrgFromApollo (or enrichOrgsBatch if no apollo_org_id yet)
 * and revalidates the page.
 */
export function ApolloCorporateContext({
  cache,
  entitySlug,
}: {
  cache: ApolloEntityCache | null;
  entitySlug: string;
}) {
  if (!cache) {
    return (
      <section className="mb-6">
        <SectionHeader
          title="Corporate context (Apollo)"
          right={<RefreshApolloButton entitySlug={entitySlug} />}
        />
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Apollo: not matched. Set the entity&apos;s primary domain, then click Refresh.
        </p>
      </section>
    );
  }

  const stale = isStale(cache.syncedAt, 30);

  return (
    <section className="mb-6">
      <SectionHeader
        title="Corporate context (Apollo)"
        right={
          <span className="flex items-center gap-2">
            <span className="text-[10px] normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
              synced {formatRelativeDate(cache.syncedAt)}
              {stale ? ' · stale' : ''}
            </span>
            <RefreshApolloButton entitySlug={entitySlug} />
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-4">
        <Field label="Employees" value={formatEmployees(cache.estimatedEmployees)} />
        <Field label="Revenue" value={formatMoney(cache.annualRevenue)} />
        <Field
          label="Funding stage"
          value={cache.fundingStage ?? '—'}
        />
        <Field
          label="Total funding"
          value={formatMoney(cache.totalFunding)}
        />
        <Field
          label="Latest round"
          value={cache.latestFundingAt ?? '—'}
        />
        <Field
          label="Industry"
          value={
            (cache.snapshot?.industry as string | null | undefined) ?? '—'
          }
        />
      </div>

      {Array.isArray(cache.snapshot?.technologyNames) &&
        (cache.snapshot.technologyNames as unknown[]).length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Tech stack (top 12)
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {(cache.snapshot.technologyNames as string[]).slice(0, 12).map((t) => (
                <span
                  key={t}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

      {typeof cache.snapshot?.shortDescription === 'string' && (
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
          {cache.snapshot.shortDescription}
        </p>
      )}

      <p className="mt-3 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Apollo populates this snapshot. Procur treats it as enrichment, not source of truth.
      </p>
    </section>
  );
}

function SectionHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      <span>{title}</span>
      {right}
    </h2>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

function formatEmployees(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1000) return `~${Math.round(n / 1000)}k`;
  return `~${n}`;
}

function formatMoney(amount: number | null): string {
  if (amount == null) return '—';
  if (amount >= 1_000_000_000) {
    return `$${(amount / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount}`;
}

function isStale(syncedAtIso: string, days: number): boolean {
  const elapsed = Date.now() - new Date(syncedAtIso).getTime();
  return elapsed > days * 24 * 60 * 60 * 1000;
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const elapsed = Date.now() - date.getTime();
  const days = Math.floor(elapsed / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
