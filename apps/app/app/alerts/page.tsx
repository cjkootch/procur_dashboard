import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listAlertProfiles } from '../../lib/alert-queries';
import { toggleAlertActiveAction } from './actions';

export const dynamic = 'force-dynamic';

const FREQUENCY_LABEL: Record<string, string> = {
  instant: 'Instant',
  daily: 'Daily digest',
  weekly: 'Weekly digest',
};

export default async function AlertsListPage() {
  const { user } = await requireCompany();
  const alerts = await listAlertProfiles(user.id);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Saved searches that notify you when new opportunities match. Each alert can scope
            by jurisdiction, category, keywords, and value range. Digests are sent by email at
            the chosen frequency.
          </p>
        </div>
        <Link
          href="/alerts/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          New alert
        </Link>
      </header>

      {alerts.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No alerts yet. Create one to get notified when matching tenders are published.
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/alerts/${a.id}`} className="text-sm font-medium hover:underline">
                    {a.name}
                  </Link>
                  {!a.active && (
                    <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                      Paused
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {FREQUENCY_LABEL[a.frequency] ?? a.frequency}
                  {a.emailEnabled ? ' · email on' : ' · email off'}
                  {a.jurisdictions && a.jurisdictions.length > 0 && (
                    <> · {a.jurisdictions.length} jurisdiction{a.jurisdictions.length === 1 ? '' : 's'}</>
                  )}
                  {a.categories && a.categories.length > 0 && (
                    <> · {a.categories.length} categor{a.categories.length === 1 ? 'y' : 'ies'}</>
                  )}
                  {a.keywords && a.keywords.length > 0 && (
                    <> · keywords: {a.keywords.slice(0, 3).join(', ')}{a.keywords.length > 3 ? '…' : ''}</>
                  )}
                </p>
              </div>
              <div className="text-right text-xs">
                <p className="font-medium">{a.matchCount} match{a.matchCount === 1 ? '' : 'es'}</p>
                <form action={toggleAlertActiveAction} className="mt-1">
                  <input type="hidden" name="id" value={a.id} />
                  <button
                    type="submit"
                    className="text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
                  >
                    {a.active ? 'Pause' : 'Resume'}
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
