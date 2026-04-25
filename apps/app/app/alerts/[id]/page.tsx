import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  getAlertProfile,
  listCategoryOptions,
  listJurisdictionOptions,
  matchOpportunities,
} from '../../../lib/alert-queries';
import { flagFor, formatDate, formatMoney, timeUntil } from '../../../lib/format';
import {
  deleteAlertAction,
  toggleAlertActiveAction,
  updateAlertAction,
} from '../actions';
import { AlertForm } from '../alert-form';

export const dynamic = 'force-dynamic';

export default async function AlertDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirmDelete?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const confirmingDelete = sp.confirmDelete === '1';
  const { user } = await requireCompany();
  const profile = await getAlertProfile(user.id, id);
  if (!profile) notFound();

  const [matches, jurisdictions, categories] = await Promise.all([
    matchOpportunities(profile, 25),
    listJurisdictionOptions(),
    listCategoryOptions(),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/alerts" className="hover:underline">
          Alerts
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">{profile.name}</span>
      </nav>

      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{profile.name}</h1>
            {!profile.active && (
              <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                Paused
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {matches.length} current match{matches.length === 1 ? '' : 'es'} · {profile.frequency} digest
            {profile.emailEnabled ? ' · email on' : ' · email off'}
          </p>
        </div>
        <form action={toggleAlertActiveAction}>
          <input type="hidden" name="id" value={profile.id} />
          <button
            type="submit"
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            {profile.active ? 'Pause' : 'Resume'}
          </button>
        </form>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Current matches
        </h2>
        {matches.length === 0 ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
            No opportunities match right now. Adjust filters below or wait — the next scraper run
            will re-check.
          </div>
        ) : (
          <div className="space-y-2">
            {matches.map((m) => {
              const discoverBase =
                process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';
              const href = m.slug ? `${discoverBase}/opportunities/${m.slug}` : undefined;
              const countdown = timeUntil(m.deadlineAt);
              return (
                <a
                  key={m.id}
                  href={href}
                  target={href ? '_blank' : undefined}
                  rel={href ? 'noopener noreferrer' : undefined}
                  className={`flex items-center gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 ${
                    href ? 'transition hover:border-[color:var(--color-foreground)]' : ''
                  }`}
                >
                  <span className="text-xl">{flagFor(m.jurisdictionCountry)}</span>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{m.title}</p>
                    <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                      {m.agencyName ?? m.jurisdictionName}
                      {m.category && <> · {m.category}</>}
                      {m.deadlineAt && <> · closes {formatDate(m.deadlineAt)}</>}
                      {countdown && countdown !== 'closed' && <> · in {countdown}</>}
                    </p>
                  </div>
                  <div className="text-right text-xs font-medium">
                    {formatMoney(m.valueEstimate, m.currency) ?? '—'}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Edit filters
        </h2>
        <AlertForm
          action={updateAlertAction}
          jurisdictions={jurisdictions}
          categories={categories}
          existing={profile}
          submitLabel="Save"
          hiddenFields={{ id: profile.id }}
        />
      </section>

      <section>
        {confirmingDelete ? (
          // Two-step delete: clicking "Delete alert" navigates here
          // (?confirmDelete=1), and only this confirmation submit
          // actually wipes the row. Prevents fat-finger loss of saved
          // searches, which take real effort to rebuild.
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-red-300 bg-red-50/40 p-3 text-xs">
            <p className="flex-1">
              Delete <span className="font-medium">&ldquo;{profile.name}&rdquo;</span>? Saved
              searches and any pending notifications for this alert are gone forever.
            </p>
            <form action={deleteAlertAction}>
              <input type="hidden" name="id" value={profile.id} />
              <button
                type="submit"
                className="rounded-[var(--radius-sm)] border border-red-400 bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
              >
                Yes, delete
              </button>
            </form>
            <Link
              href={`/alerts/${profile.id}`}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-muted)]/40"
            >
              Cancel
            </Link>
          </div>
        ) : (
          <Link
            href={`/alerts/${profile.id}?confirmDelete=1`}
            className="text-xs text-[color:var(--color-muted-foreground)] hover:text-red-600"
          >
            Delete alert
          </Link>
        )}
      </section>
    </div>
  );
}
