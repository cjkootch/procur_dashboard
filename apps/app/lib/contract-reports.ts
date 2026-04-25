import 'server-only';
import { eq } from 'drizzle-orm';
import { contracts, db } from '@procur/db';
// Bucket boundaries live in @procur/utils so /contract/reports and
// /discover/opportunities share the exact same tiers — previously they
// drifted (4 buckets vs 5, slightly different labels).
import { bucketLabel as valueBucket } from '@procur/utils';

/**
 * Contract reporting — pure SQL-side aggregation against the contracts
 * table. No new tables, no new indexes; just a flexible measure +
 * slice-by + (optional) segment-by pivot calculator.
 *
 * Mirrors GovDash's Reporting modal (folder 4 screenshot) but adapted
 * for emerging-market vocab — no NAICS/PSC; we use jurisdiction,
 * agency, status, tier, currency, value bucket, and award year.
 *
 * Strategy: load the contracts table once for the company (typically
 * 10s–100s of rows), then aggregate in memory. Cheaper than building
 * dynamic GROUP BY in drizzle for v1, and lets us add value buckets
 * and award-year derivations without SQL gymnastics.
 */

export const MEASURES = ['count', 'total_value', 'avg_value'] as const;
export type Measure = (typeof MEASURES)[number];

export const MEASURE_LABEL: Record<Measure, string> = {
  count: 'Contract count',
  total_value: 'Total value (USD)',
  avg_value: 'Average value (USD)',
};

export const SLICE_BYS = [
  'jurisdiction',
  'agency',
  'status',
  'tier',
  'award_year',
  'value_bucket',
  'currency',
] as const;
export type SliceBy = (typeof SLICE_BYS)[number];

export const SLICE_BY_LABEL: Record<SliceBy, string> = {
  jurisdiction: 'Jurisdiction',
  agency: 'Awarding agency',
  status: 'Status',
  tier: 'Tier (prime/sub/TO)',
  award_year: 'Award year',
  value_bucket: 'Value bucket',
  currency: 'Currency',
};

function dimensionValue(
  row: typeof contracts.$inferSelect,
  dim: SliceBy,
): string {
  switch (dim) {
    case 'jurisdiction':
      // We don't have a jurisdiction FK on contracts in v1 — use the
      // free-text awardingAgency string as a proxy bucket (often country-
      // agency formatted). Falls back to '—'.
      return row.awardingAgency ?? '—';
    case 'agency':
      return row.awardingAgency ?? '—';
    case 'status':
      return row.status;
    case 'tier':
      return row.tier;
    case 'currency':
      return row.currency ?? 'USD';
    case 'award_year':
      return row.awardDate ? row.awardDate.slice(0, 4) : '—';
    case 'value_bucket':
      return valueBucket(row.totalValueUsd ? Number(row.totalValueUsd) : null);
  }
}

export type ReportCell = {
  label: string;
  measure: number;
  segments?: Record<string, number>;
};

export type ReportResult = {
  measure: Measure;
  sliceBy: SliceBy;
  segmentBy: SliceBy | null;
  cells: ReportCell[];
  total: number;
  segmentLabels: string[];
};

export async function buildContractReport(
  companyId: string,
  measure: Measure,
  sliceBy: SliceBy,
  segmentBy: SliceBy | null,
): Promise<ReportResult> {
  const rows = await db.select().from(contracts).where(eq(contracts.companyId, companyId));

  // First aggregate the slice — sum/count/avg by sliceBy bucket.
  type Bucket = { count: number; sum: number; values: number[] };
  const buckets = new Map<string, Bucket>();
  const segmentBuckets = new Map<string, Map<string, Bucket>>();

  for (const r of rows) {
    const sliceKey = dimensionValue(r, sliceBy);
    const usd = r.totalValueUsd ? Number(r.totalValueUsd) : 0;

    const b = buckets.get(sliceKey) ?? { count: 0, sum: 0, values: [] };
    b.count += 1;
    b.sum += usd;
    b.values.push(usd);
    buckets.set(sliceKey, b);

    if (segmentBy) {
      const segKey = dimensionValue(r, segmentBy);
      const segMap = segmentBuckets.get(sliceKey) ?? new Map<string, Bucket>();
      const sb = segMap.get(segKey) ?? { count: 0, sum: 0, values: [] };
      sb.count += 1;
      sb.sum += usd;
      sb.values.push(usd);
      segMap.set(segKey, sb);
      segmentBuckets.set(sliceKey, segMap);
    }
  }

  const reduceMeasure = (b: Bucket): number => {
    if (measure === 'count') return b.count;
    if (measure === 'total_value') return Math.round(b.sum);
    // avg_value
    if (b.count === 0) return 0;
    return Math.round(b.sum / b.count);
  };

  const cells: ReportCell[] = Array.from(buckets.entries()).map(([label, b]) => {
    const segments = segmentBy
      ? Object.fromEntries(
          Array.from(segmentBuckets.get(label)?.entries() ?? []).map(([k, v]) => [
            k,
            reduceMeasure(v),
          ]),
        )
      : undefined;
    return { label, measure: reduceMeasure(b), segments };
  });

  // Sort descending by measure (largest bar first), but stick "—" / "No value
  // set" at the end so empty buckets don't dominate the top.
  cells.sort((a, b) => {
    const aEmpty = a.label === '—' || a.label === 'No value set';
    const bEmpty = b.label === '—' || b.label === 'No value set';
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    return b.measure - a.measure;
  });

  // Collect every segment label across all cells, sorted alphabetically.
  const segmentLabelSet = new Set<string>();
  if (segmentBy) {
    for (const c of cells) {
      for (const k of Object.keys(c.segments ?? {})) segmentLabelSet.add(k);
    }
  }

  const total =
    measure === 'count'
      ? rows.length
      : measure === 'total_value'
        ? Math.round(rows.reduce((acc, r) => acc + (r.totalValueUsd ? Number(r.totalValueUsd) : 0), 0))
        : rows.length === 0
          ? 0
          : Math.round(
              rows.reduce((acc, r) => acc + (r.totalValueUsd ? Number(r.totalValueUsd) : 0), 0) /
                rows.length,
            );

  return {
    measure,
    sliceBy,
    segmentBy,
    cells,
    total,
    segmentLabels: Array.from(segmentLabelSet).sort(),
  };
}

export function isMeasure(v: string | undefined): v is Measure {
  return MEASURES.includes((v ?? '') as Measure);
}

export function isSliceBy(v: string | undefined): v is SliceBy {
  return SLICE_BYS.includes((v ?? '') as SliceBy);
}
