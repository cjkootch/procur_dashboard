/**
 * Shared value-bucket boundaries for USD-normalized contract / opportunity
 * value. Used by:
 *   - apps/app/lib/contract-reports.ts (slice-by dimension)
 *   - apps/discover/app/opportunities/page.tsx (search filter range)
 *
 * Boundaries are deliberately power-of-ten so bins read cleanly. Discover
 * prepends an "Any" sentinel and may collapse the top tier (>$10M) for a
 * shorter filter list — the boundary values stay aligned.
 */

export type ValueBucket = {
  /** Display label, e.g. "$100K – $1M". */
  label: string;
  /** Inclusive lower bound in USD. 0 / undefined means "no lower bound". */
  min: number;
  /** Exclusive upper bound in USD. Number.POSITIVE_INFINITY means "no cap". */
  max: number;
};

export const VALUE_BUCKETS: ValueBucket[] = [
  { label: 'Under $100K', min: 0, max: 100_000 },
  { label: '$100K – $1M', min: 100_000, max: 1_000_000 },
  { label: '$1M – $10M', min: 1_000_000, max: 10_000_000 },
  { label: '$10M – $100M', min: 10_000_000, max: 100_000_000 },
  { label: '$100M+', min: 100_000_000, max: Number.POSITIVE_INFINITY },
];

/** Bucket label for a USD amount; null → "No value set". */
export function bucketLabel(usd: number | null | undefined): string {
  if (usd == null) return 'No value set';
  for (const b of VALUE_BUCKETS) {
    if (usd >= b.min && usd < b.max) return b.label;
  }
  return 'No value set';
}
