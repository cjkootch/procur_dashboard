import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDispositionHeatMap, type DispositionHeatMapRow } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const dynamic = 'force-dynamic';

/**
 * Disposition heat-map per docs/feedback-ui-brief.md §7.3.
 * Column-grouped view of every entity with a current disposition,
 * with stale ⚠️ amber badges driving batch-update prompts.
 *
 * Columns mirror the ENTITY_DISPOSITIONS taxonomy in the order the
 * brief specs (active → dormant → dead → declined → never_contacted).
 */
const COLUMNS: Array<{
  value: DispositionHeatMapRow['disposition'];
  label: string;
  pill: string;
}> = [
  { value: 'active_pursuing', label: 'Active — pursuing', pill: 'bg-emerald-500/15 text-emerald-800' },
  { value: 'active_exploratory', label: 'Active — exploratory', pill: 'bg-emerald-500/10 text-emerald-700' },
  { value: 'dormant', label: 'Dormant', pill: 'bg-amber-500/10 text-amber-800' },
  { value: 'dead', label: 'Dead', pill: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]' },
  { value: 'declined', label: 'Declined', pill: 'bg-red-500/10 text-red-700' },
  { value: 'never_contacted', label: 'Never contacted', pill: 'bg-blue-500/10 text-blue-700' },
];

export default async function DispositionHeatMapPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const rows = await getDispositionHeatMap(user.id, 1000);
  const byDisposition = COLUMNS.map((c) => ({
    ...c,
    entries: rows.filter((r) => r.disposition === c.value),
  }));
  const staleCount = rows.filter((r) => r.isStale).length;

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">📊 Relationship heat-map</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Your current disposition for every entity in the rolodex.
          Set via the Disposition panel on each entity profile. Stale
          rows (⚠️ amber, &gt;30d since last update) prompt batch
          refreshes — see brief discipline §7.3.
        </p>
        {staleCount > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            ⚠️ {staleCount} disposition{staleCount === 1 ? '' : 's'} stale (&gt;30d). Open the entity to refresh.
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No dispositions set yet. Visit any entity profile and use the
          Disposition panel to record where the relationship stands.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {byDisposition.map((col) => (
            <div
              key={col.value}
              className="rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-muted)]/20 p-3"
            >
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${col.pill}`}>
                  {col.label}
                </h2>
                <span className="text-xs tabular-nums text-[color:var(--color-muted-foreground)]">
                  {col.entries.length}
                </span>
              </div>
              {col.entries.length === 0 ? (
                <p className="text-[11px] italic text-[color:var(--color-muted-foreground)]">empty</p>
              ) : (
                <ul className="space-y-0.5">
                  {col.entries.map((e) => {
                    const days = Math.floor((Date.now() - new Date(e.setAt).getTime()) / 86400000);
                    return (
                      <li key={e.entitySlug} className="flex items-baseline justify-between gap-2 text-xs">
                        <Link
                          href={`/entities/${encodeURIComponent(e.entitySlug)}`}
                          className="truncate hover:underline"
                          title={e.declineReason ?? undefined}
                        >
                          {e.entityName}
                          {e.entityCountry && (
                            <span className="ml-1 text-[10px] tabular-nums text-[color:var(--color-muted-foreground)]">
                              {e.entityCountry}
                            </span>
                          )}
                        </Link>
                        <span className={`shrink-0 tabular-nums ${e.isStale ? 'text-amber-700' : 'text-[color:var(--color-muted-foreground)]'}`}>
                          {days}d{e.isStale ? ' ⚠️' : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
