import Link from 'next/link';
import { seedSampleDataAction } from '../../app/onboarding/sample-data-action';
import type { OnboardingProgress } from '../../lib/onboarding-progress';

/**
 * Setup checklist card for the home page. Renders only when the user
 * has at least one incomplete step — once they hit 100%, the card
 * disappears so it doesn't clutter the dashboard for established users.
 *
 * Each step is a row that links to the page where they can complete
 * it. Done steps render with a green check + strike-through; pending
 * steps render with an open circle and an arrow.
 */
export function SetupChecklist({ progress }: { progress: OnboardingProgress }) {
  if (progress.doneCount === progress.totalCount) return null;

  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Get set up</h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            A few quick steps to get the most out of Procur. This card disappears
            once you finish.
          </p>
        </div>
        <p className="shrink-0 text-xs font-mono text-[color:var(--color-muted-foreground)]">
          {progress.doneCount}/{progress.totalCount} · {progress.percent}%
        </p>
      </header>

      {/* Progress bar */}
      <div
        className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-muted)]/40"
        aria-hidden
      >
        <div
          className="h-full bg-[color:var(--color-foreground)] transition-all"
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      <ol className="space-y-1.5">
        {progress.steps.map((step) => (
          <li key={step.id}>
            <Link
              href={step.href}
              className={`flex items-start gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 transition hover:bg-[color:var(--color-muted)]/40 ${
                step.done ? 'opacity-60' : ''
              }`}
            >
              <span
                aria-hidden
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  step.done
                    ? 'bg-emerald-500 text-white'
                    : 'border border-[color:var(--color-border)]'
                }`}
              >
                {step.done ? '✓' : ''}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${step.done ? 'line-through text-[color:var(--color-muted-foreground)]' : 'font-medium'}`}
                >
                  {step.title}
                </p>
                {!step.done && (
                  <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    {step.hint}
                  </p>
                )}
              </div>
              {!step.done && (
                <span
                  aria-hidden
                  className="shrink-0 self-center text-sm text-[color:var(--color-muted-foreground)]"
                >
                  →
                </span>
              )}
            </Link>
          </li>
        ))}
      </ol>

      {/* Try-with-sample-data shortcut for the empty-state cliff. We
          gate this on first_pursuit being undone — once the user has
          a real pursuit, sample data would just clutter their pipeline. */}
      {progress.steps.find((s) => s.id === 'first_pursuit' && !s.done) && (
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-sm)] border border-dashed border-[color:var(--color-border)] p-3">
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            No tenders in your jurisdictions yet?{' '}
            <span className="text-[color:var(--color-foreground)]">Try Procur with sample data</span>
            {' '}— two pursuits, a contract, a library doc, and a past performance entry, all
            tagged <span className="font-mono">[Sample]</span> so you can clear them later.
          </p>
          <form action={seedSampleDataAction}>
            <button
              type="submit"
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              Seed sample data
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
