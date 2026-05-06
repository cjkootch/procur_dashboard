import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDealRetrospective } from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { RetrospectiveForm } from './RetrospectiveForm';

export const dynamic = 'force-dynamic';

/**
 * Retrospective form page for a single (deal, user). Per
 * docs/feedback-ui-brief.md §8.2.
 *
 * Reachable via:
 *   - Direct URL `/retrospectives/{vex_deal_id}` from a user-typed
 *     link or vex's deal-closure email (when that wires in)
 *   - The auto-generated retrospective queue once the 7-day delayed
 *     notification system is built (gated on Trigger.dev v3→v4)
 *
 * Search-param `outcome` lets vex/external links pre-set the
 * outcome for fresh retrospectives:
 *   /retrospectives/abc123?outcome=won
 */
interface Props {
  params: Promise<{ dealId: string }>;
  searchParams: Promise<{ outcome?: 'won' | 'lost' | 'dead' }>;
}

export default async function RetrospectivePage({ params, searchParams }: Props) {
  const { dealId } = await params;
  const { outcome } = await searchParams;
  const user = await getCurrentUser();
  if (!user) {
    notFound();
  }

  const decodedDealId = decodeURIComponent(dealId);
  const existing = await getDealRetrospective(decodedDealId, user.id);
  const defaultOutcome: 'won' | 'lost' | 'dead' =
    outcome ?? existing?.dealOutcome ?? 'won';

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/" className="hover:text-[color:var(--color-foreground)]">
          ← Home
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Deal retrospective</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Vex deal{' '}
          <code className="rounded bg-[color:var(--color-muted)] px-1 font-mono text-xs">
            {decodedDealId}
          </code>
          . 5-7 minutes; lessons get surfaced during similar future
          deals (once the ML similarity layer's embeddings are
          populated).
        </p>
        {existing?.isDraft && (
          <p className="mt-2 text-xs text-amber-700">Draft — not yet submitted.</p>
        )}
        {existing?.completedAt && !existing.isDraft && (
          <p className="mt-2 text-xs text-emerald-700">
            Completed {new Date(existing.completedAt).toLocaleDateString()}.
          </p>
        )}
      </header>

      <RetrospectiveForm
        dealId={decodedDealId}
        initial={existing}
        defaultOutcome={defaultOutcome}
      />

      <p className="mt-6 text-[10px] text-[color:var(--color-muted-foreground)]">
        Per docs/feedback-ui-brief.md §8 — 7-day delayed retrospective
        notifications + similar-deal surfacing during future opportunities
        land as Trigger.dev cron + ML Component A integration follow-ups.
      </p>
    </div>
  );
}
