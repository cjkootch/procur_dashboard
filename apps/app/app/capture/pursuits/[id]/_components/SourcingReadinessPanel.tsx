import Link from 'next/link';
import { getSupplierApprovalRollup } from '@procur/catalog';

/**
 * Pursuit-detail "Sourcing readiness" panel — answers "do I have
 * approved counterparties to actually source for this opportunity?"
 * at a glance, with a deep-link to the filtered rolodex.
 *
 * No-op when the opportunity has no category (opp.category is
 * nullable on the schema; we don't want to count against the whole
 * universe by accident). When there are zero approved suppliers in
 * the category, render as a blocker callout instead of a green
 * count — sourcing readiness is a real ship-blocker for fuel deals.
 */
export type SourcingReadinessPanelProps = {
  companyId: string;
  /** opportunities.category — free-text, may be null. */
  opportunityCategory: string | null;
};

export async function SourcingReadinessPanel({
  companyId,
  opportunityCategory,
}: SourcingReadinessPanelProps) {
  if (!opportunityCategory) return null;

  const rollup = await getSupplierApprovalRollup(companyId, opportunityCategory);

  // Zero approved + zero in-flight + zero expired = no engagement at
  // all in this category. That's a hard blocker; surface as a
  // callout so it's the first thing the user sees on the pursuit.
  if (
    rollup.totalApproved === 0 &&
    rollup.inFlight === 0 &&
    rollup.expired === 0
  ) {
    return (
      <section className="mt-4 rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base">⚠</span>
          <span className="font-medium text-amber-900">
            No approved suppliers for{' '}
            <code className="font-mono text-xs">{opportunityCategory}</code>
          </span>
          <span className="text-amber-800">
            — engagement needed before this pursuit can ship.
          </span>
          <Link
            href={`/suppliers/known-entities?category=${encodeURIComponent(opportunityCategory)}`}
            className="ml-auto rounded-[var(--radius-sm)] bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-800"
          >
            Browse {opportunityCategory} suppliers →
          </Link>
        </div>
      </section>
    );
  }

  const status =
    rollup.totalApproved > 0
      ? rollup.totalApproved === 1
        ? '1 approved supplier'
        : `${rollup.totalApproved} approved suppliers`
      : 'no approved suppliers yet';

  const tone =
    rollup.totalApproved >= 3
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : rollup.totalApproved >= 1
        ? 'border-sky-200 bg-sky-50 text-sky-900'
        : 'border-amber-200 bg-amber-50 text-amber-900';

  return (
    <section
      className={`mt-4 rounded-[var(--radius-md)] border px-4 py-2.5 text-sm ${tone}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">Sourcing readiness:</span>
        <span>
          {status} for{' '}
          <code className="font-mono text-xs">{opportunityCategory}</code>
        </span>
        {rollup.inFlight > 0 && (
          <span className="opacity-80">· {rollup.inFlight} in flight</span>
        )}
        {rollup.expired > 0 && (
          <span className="opacity-80">
            · {rollup.expired} KYC expired (re-cert needed)
          </span>
        )}
        <Link
          href={`/suppliers/known-entities?approval=approved&category=${encodeURIComponent(opportunityCategory)}`}
          className="ml-auto text-xs font-medium underline hover:no-underline"
        >
          See approved →
        </Link>
      </div>
    </section>
  );
}
