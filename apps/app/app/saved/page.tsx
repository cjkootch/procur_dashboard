import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { listSavedOpportunities } from '../../lib/saved-queries';
import { flagFor, formatDate, formatMoney, timeUntil } from '../../lib/format';
import { unsaveOpportunityAction, updateSavedNotesAction } from './actions';

export const dynamic = 'force-dynamic';

const DISCOVER_BASE =
  process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export default async function SavedOpportunitiesPage() {
  const { user, company } = await requireCompany();
  const rows = await listSavedOpportunities(user.id, company.id);

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Saved opportunities</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Your bookmarks from Discover. Convert them into pursuits when you&rsquo;re ready to bid
          — that lets the team collaborate, price, and draft a proposal together.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No saved opportunities yet.
          <br />
          Browse tenders on{' '}
          <a href={DISCOVER_BASE} target="_blank" rel="noopener noreferrer" className="underline">
            Discover
          </a>{' '}
          and bookmark the ones you want to track.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const countdown = timeUntil(r.deadlineAt);
            const discoverHref = r.slug
              ? `${DISCOVER_BASE}/opportunities/${r.slug}`
              : null;
            return (
              <div
                key={r.savedId}
                className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="text-lg">{flagFor(r.jurisdictionCountry)}</span>
                  <div className="flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        {discoverHref ? (
                          <a
                            href={discoverHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium hover:underline"
                          >
                            {r.title}
                          </a>
                        ) : (
                          <p className="text-sm font-medium">{r.title}</p>
                        )}
                        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                          {r.agencyName ?? r.jurisdictionName}
                          {r.referenceNumber && <> · {r.referenceNumber}</>}
                          {r.category && <> · {r.category}</>}
                        </p>
                        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                          Saved {formatDate(r.savedAt)}
                          {r.deadlineAt && <> · closes {formatDate(r.deadlineAt)}</>}
                          {countdown && countdown !== 'closed' && <> · in {countdown}</>}
                          {r.status !== 'active' && (
                            <>
                              {' '}
                              · <span className="text-red-700">{r.status}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="text-right text-xs">
                        <p className="font-medium">
                          {formatMoney(r.valueEstimate, r.currency) ?? '—'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {r.hasActivePursuit && r.pursuitId ? (
                        <Link
                          href={`/capture/pursuits/${r.pursuitId}`}
                          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                        >
                          Pursuit details →
                        </Link>
                      ) : (
                        <Link
                          href={`/capture/new?opportunityId=${r.opportunityId}`}
                          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)]"
                        >
                          Convert to pursuit
                        </Link>
                      )}
                      <form action={unsaveOpportunityAction}>
                        <input type="hidden" name="savedId" value={r.savedId} />
                        <button
                          type="submit"
                          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-brand)]"
                        >
                          Unsave
                        </button>
                      </form>
                    </div>

                    <form action={updateSavedNotesAction} className="mt-3 flex items-start gap-2">
                      <input type="hidden" name="savedId" value={r.savedId} />
                      <textarea
                        name="notes"
                        rows={1}
                        defaultValue={r.notes ?? ''}
                        placeholder="Private notes (why you saved this, next step…)"
                        className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-xs"
                      />
                      <button
                        type="submit"
                        className="text-xs text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
                      >
                        Save
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
