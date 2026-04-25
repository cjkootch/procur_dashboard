import Link from 'next/link';
import { AdminShell } from '../../components/shell/AdminShell';
import { listTenantOptions } from '../../lib/audit-queries';
import {
  listWebhookEvents,
  WEBHOOK_PAGE_SIZE,
  type WebhookRow,
} from '../../lib/webhook-queries';
import { replayWebhookEventAction } from './actions';

type SearchParams = {
  provider?: string;
  status?: string;
  companyId?: string;
  page?: string;
};

const PROVIDERS = ['stripe', 'clerk'] as const;
const STATUSES = [
  { id: 'ok', label: 'Handled OK' },
  { id: 'rejected', label: 'Rejected (bad signature)' },
  { id: 'error', label: 'Handler error' },
] as const;

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Number.parseInt(sp.page ?? '1', 10) || 1;
  const provider =
    sp.provider === 'stripe' || sp.provider === 'clerk' ? sp.provider : undefined;
  const status =
    sp.status === 'ok' || sp.status === 'rejected' || sp.status === 'error'
      ? sp.status
      : undefined;

  const [events, tenantOptions] = await Promise.all([
    listWebhookEvents({
      provider,
      status,
      companyId: sp.companyId || undefined,
      page,
    }),
    listTenantOptions(),
  ]);

  const params = new URLSearchParams();
  if (sp.provider) params.set('provider', sp.provider);
  if (sp.status) params.set('status', sp.status);
  if (sp.companyId) params.set('companyId', sp.companyId);
  const prevHref = page > 1 ? `?${withPage(params, page - 1)}` : null;
  const nextHref = events.hasMore ? `?${withPage(params, page + 1)}` : null;

  return (
    <AdminShell title="Webhook events">
      <div className="mx-auto max-w-7xl px-8 py-10">
        <header className="mb-4">
          <h2 className="text-lg font-semibold">Inbound webhooks</h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Every Stripe + Clerk webhook hit lands here, including signature
            failures and handler crashes. Use the filters to scope by
            provider, status, or tenant. Page size {WEBHOOK_PAGE_SIZE}.
          </p>
        </header>

        <form
          method="GET"
          className="mb-4 grid gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 sm:grid-cols-[1fr_1.5fr_2fr_auto]"
        >
          <Field label="Provider">
            <select
              name="provider"
              defaultValue={sp.provider ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm capitalize"
            >
              <option value="">All providers</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue={sp.status ?? ''}
              className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
            >
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
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
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
            >
              Apply
            </button>
            <Link
              href="/webhooks"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
            >
              Reset
            </Link>
          </div>
        </form>

        {events.rows.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No webhook events match these filters.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
            {events.rows.map((row) => (
              <li key={row.id}>
                <WebhookRowView row={row} />
              </li>
            ))}
          </ul>
        )}

        <nav className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted-foreground)]">
          <span>
            Page {events.page} · showing {events.rows.length}
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

function WebhookRowView({ row }: { row: WebhookRow }) {
  const statusBucket = row.signatureValid
    ? row.processedAt
      ? 'ok'
      : 'error'
    : 'rejected';
  const tone =
    statusBucket === 'ok'
      ? 'text-emerald-700'
      : statusBucket === 'rejected'
        ? 'text-amber-700'
        : 'text-red-700';

  return (
    <details className="px-4 py-2.5">
      <summary className="cursor-pointer text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate">
              <span className="font-mono text-[11px] uppercase">{row.provider}</span>
              {row.eventType && (
                <span className="ml-2 font-mono text-[11px]">{row.eventType}</span>
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
            <p className="text-[10px] font-mono text-[color:var(--color-muted-foreground)]">
              {row.eventId ?? '—'} · {row.responseStatus} ·{' '}
              <span className={tone}>{statusBucket}</span>
              {row.errorMessage && <> · {row.errorMessage}</>}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
            {row.receivedAt.toLocaleString()}
          </span>
        </div>
      </summary>
      {row.payload != null && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
            payload
          </p>
          <pre className="overflow-x-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-2 text-[11px] font-mono">
            {JSON.stringify(row.payload, null, 2)}
          </pre>
        </div>
      )}
      {/* Replay is only meaningful for Stripe events that have a stored
          payload AND didn't end in a successful processed handler.
          Re-running an already-OK event would double-apply the
          subscription update; the no-op switch in processStripeEvent
          handles most cases idempotently, but it's still cleaner to
          hide the button. */}
      {row.provider === 'stripe' &&
        row.payload != null &&
        statusBucket !== 'ok' && (
          <form action={replayWebhookEventAction} className="mt-2 flex items-center gap-2">
            <input type="hidden" name="eventRowId" value={row.id} />
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)]/40 bg-[color:var(--color-background)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40"
            >
              Replay
            </button>
            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
              Re-runs the handler with the stored payload. Audit-logged. Adds a
              new row showing the replay outcome.
            </span>
          </form>
        )}
    </details>
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
