import Link from 'next/link';
import { generateFromContractAction } from '../../past-performance/actions';

/**
 * Past Performance tab — the generate-from-contract CTA, lifted from the
 * old monolith. If a past-performance entry already exists for this
 * contract (matched by project name), show a deep-link instead of the
 * generate form.
 */
export function PastPerformanceTab({
  contractId,
  existingPastPerformanceId,
}: {
  contractId: string;
  existingPastPerformanceId: string | null;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
        <h2 className="mb-1 text-sm font-semibold">Past performance entry</h2>
        <p className="mb-4 text-xs text-[color:var(--color-muted-foreground)]">
          Turn this contract into a reusable reference for future proposals.
          Carries over customer, period, value, and any completed obligations as
          accomplishments.
        </p>
        {existingPastPerformanceId ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">
              A past-performance entry has already been generated for this contract.
            </p>
            <Link
              href={`/past-performance/${existingPastPerformanceId}`}
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              View entry →
            </Link>
          </div>
        ) : (
          <form action={generateFromContractAction}>
            <input type="hidden" name="contractId" value={contractId} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Generate past performance
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
