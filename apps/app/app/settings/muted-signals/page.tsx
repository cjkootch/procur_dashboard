import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listSignalMuteRulesForUser } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { UnmuteButton } from './_components/UnmuteButton';

export const dynamic = 'force-dynamic';

/**
 * Mute-rules management per docs/feedback-ui-brief.md §4.3 — "The mute
 * applies until the user un-mutes (via entity settings)…"
 *
 * Lists the user's active signal_mute_rules with un-mute actions.
 * Each rule was created via the 🔇 button or `m` shortcut on the
 * match queue.
 */
export default async function MutedSignalsPage() {
  const user = await getCurrentUser();
  if (!user) notFound();

  const rules = await listSignalMuteRulesForUser(user.id);

  // Group by entity for at-a-glance scan — most users mute multiple
  // signal types per entity (e.g. distress_event + new_award) once
  // they decide an entity isn't worth surfacing.
  const byEntity = new Map<string, typeof rules>();
  for (const r of rules) {
    const list = byEntity.get(r.entitySlug) ?? [];
    list.push(r);
    byEntity.set(r.entitySlug, list);
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/settings" className="hover:text-[color:var(--color-foreground)]">
          ← Settings
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">🔇 Muted signals</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Mute rules you set via the 🔇 button or{' '}
          <kbd className="rounded border border-[color:var(--color-border)] px-1 text-[10px]">m</kbd>{' '}
          shortcut on the match queue. Each rule suppresses one
          signal type from one source for one entity.
        </p>
      </header>

      {rules.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          No active mutes. The match-queue surfaces every signal until you mute it.
        </p>
      ) : (
        <ul className="space-y-3">
          {[...byEntity.entries()].map(([slug, entityRules]) => (
            <li
              key={slug}
              className="rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-muted)]/20 p-3"
            >
              <div className="mb-2">
                <Link
                  href={`/entities/${encodeURIComponent(slug)}`}
                  className="text-sm font-medium hover:underline"
                >
                  {slug}
                </Link>
                <span className="ml-2 text-[11px] tabular-nums text-[color:var(--color-muted-foreground)]">
                  {entityRules.length} mute{entityRules.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="space-y-1.5">
                {entityRules.map((r) => (
                  <li
                    key={`${r.entitySlug}-${r.signalType}-${r.signalSource ?? '*'}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700">
                        {r.signalType}
                      </span>
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {r.signalSource ? `from ${r.signalSource}` : '(any source)'}
                      </span>
                      <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                        muted {formatRelative(r.mutedAt)}
                      </span>
                    </div>
                    <UnmuteButton
                      entitySlug={r.entitySlug}
                      signalType={r.signalType}
                      signalSource={r.signalSource}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
