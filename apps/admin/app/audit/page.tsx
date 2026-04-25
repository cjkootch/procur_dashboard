import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import {
  AUDIT_PAGE_SIZE,
  listAuditEvents,
  listRecentActions,
  listTenantOptions,
  type AuditRow,
} from '../../lib/audit-queries';

type SearchParams = {
  companyId?: string;
  action?: string;
  entityType?: string;
  fromDate?: string;
  toDate?: string;
  page?: string;
};

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Number.parseInt(sp.page ?? '1', 10) || 1;

  const [events, recentActions, tenantOptions] = await Promise.all([
    listAuditEvents({
      companyId: sp.companyId || undefined,
      action: sp.action || undefined,
      entityType: sp.entityType || undefined,
      fromDate: sp.fromDate || undefined,
      toDate: sp.toDate || undefined,
      page,
    }),
    listRecentActions(),
    listTenantOptions(),
  ]);

  const params = new URLSearchParams();
  if (sp.companyId) params.set('companyId', sp.companyId);
  if (sp.action) params.set('action', sp.action);
  if (sp.entityType) params.set('entityType', sp.entityType);
  if (sp.fromDate) params.set('fromDate', sp.fromDate);
  if (sp.toDate) params.set('toDate', sp.toDate);

  const prevHref = page > 1 ? `?${withPage(params, page - 1)}` : null;
  const nextHref = events.hasMore ? `?${withPage(params, page + 1)}` : null;

  return (
    <AdminShell title="Audit log">
      <div className="mx-auto max-w-7xl px-8 py-10">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">Audit events</h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Cross-tenant view. Use the filters to scope by tenant, action,
            entity type, or date range. Page size {AUDIT_PAGE_SIZE}.
          </p>
        </header>

        {/* Filters */}
        <form
          method="GET"
          className="mb-4 grid gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 sm:grid-cols-[1.5fr_1.5fr_0.8fr_0.8fr_0.8fr_auto]"
        >
          <Field label="Tenant">
            <select
              name="companyId"
              defaultValue={sp.companyId ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              <option value="">All tenants</option>
              {tenantOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Action">
            <select
              name="action"
              defaultValue={sp.action ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              <option value="">All actions</option>
              {recentActions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Entity type">
            <input
              name="entityType"
              defaultValue={sp.entityType ?? ''}
              placeholder="pursuit / company / …"
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="From">
            <input
              name="fromDate"
              type="date"
              defaultValue={sp.fromDate ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </Field>
          <Field label="To">
            <input
              name="toDate"
              type="date"
              defaultValue={sp.toDate ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            />
          </Field>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
            >
              Apply
            </button>
            <Link
              href="/audit"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
            >
              Reset
            </Link>
          </div>
        </form>

        {/* Rows */}
        {events.rows.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No events match these filters.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
            {events.rows.map((r) => (
              <li key={r.id}>
                <AuditEventRow row={r} />
              </li>
            ))}
          </ul>
        )}

        {/* Pagination */}
        <nav className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted-foreground)]">
          <span>
            Page {events.page} · showing {events.rows.length} events
            {events.hasMore ? ' · more available' : ''}
          </span>
          <span className="flex gap-2">
            {prevHref ? (
              <Link
                href={prevHref}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:bg-[color:var(--color-muted)]/40"
              >
                ← Prev
              </Link>
            ) : (
              <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 opacity-40">
                ← Prev
              </span>
            )}
            {nextHref ? (
              <Link
                href={nextHref}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:bg-[color:var(--color-muted)]/40"
              >
                Next →
              </Link>
            ) : (
              <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 opacity-40">
                Next →
              </span>
            )}
          </span>
        </nav>
      </div>
    </AdminShell>
  );
}

function AuditEventRow({ row }: { row: AuditRow }) {
  const hasJson =
    (row.changes != null && Object.keys(row.changes as object).length > 0) ||
    (row.metadata != null && Object.keys(row.metadata as object).length > 0);

  return (
    <details className="px-4 py-2.5">
      <summary className="cursor-pointer text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                {row.action}
              </span>
              {row.actorName || row.actorEmail ? (
                <span className="ml-2 text-[color:var(--color-foreground)]">
                  by {row.actorName || row.actorEmail}
                </span>
              ) : null}
              {(row.impersonatorName || row.impersonatorEmail) && (
                <span
                  title="Staff member who drove this action via Clerk impersonation"
                  className="ml-1.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-amber-500 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900"
                >
                  impersonated by {row.impersonatorName || row.impersonatorEmail}
                </span>
              )}
              {row.companyName && (
                <>
                  {' · '}
                  <Link
                    href={`/tenants/${row.companyId}`}
                    className="text-[color:var(--color-foreground)] hover:underline"
                  >
                    {row.companyName}
                  </Link>
                </>
              )}
            </p>
            {(row.entityType || row.entityId) && (
              <p className="text-[10px] font-mono text-[color:var(--color-muted-foreground)]">
                {row.entityType ?? '—'} {row.entityId ? `· ${row.entityId}` : ''}
              </p>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
            {row.createdAt.toLocaleString()}
          </span>
        </div>
      </summary>
      {hasJson && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {row.changes != null && (
            <JsonBlock label="changes" value={row.changes} />
          )}
          {row.metadata != null && (
            <JsonBlock label="metadata" value={row.metadata} />
          )}
        </div>
      )}
    </details>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-2 text-[11px] font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function withPage(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params);
  next.set('page', page.toString());
  return next.toString();
}
