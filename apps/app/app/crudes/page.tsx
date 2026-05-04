import Link from 'next/link';
import {
  listCrudeGradeRegions,
  listCrudeGradesForIndex,
  type CrudeGradeIndexRow,
} from '@procur/catalog';

/**
 * Crude grades catalog — searchable + filterable index of every
 * curated grade in the rolodex, with assay availability flagged
 * per row. Click any row to drill into the detail page (`/crudes/[slug]`)
 * which shows the full TBP cut chart + producer comparison.
 *
 * Filters are URL-driven (`?search=...&region=...&sweet=1&light=1`)
 * so links are shareable + the back button works as expected.
 *
 * Server component. Auth via apps/app/middleware.ts.
 */
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{
    search?: string;
    region?: string;
    sweet?: string;
    light?: string;
    marker?: string;
  }>;
}

export default async function CrudeGradesIndex({ searchParams }: Props) {
  const sp = await searchParams;
  const filters = {
    search: sp.search,
    region: sp.region,
    sweetOnly: sp.sweet === '1',
    lightOnly: sp.light === '1',
    markerFilter:
      sp.marker === 'marker'
        ? ('marker' as const)
        : sp.marker === 'non-marker'
          ? ('non-marker' as const)
          : undefined,
  };
  const [grades, regions] = await Promise.all([
    listCrudeGradesForIndex(filters),
    listCrudeGradeRegions(),
  ]);

  const totalAssayed = grades.filter((g) => g.assayCount > 0).length;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Crude grades</h1>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          {grades.length} grade{grades.length === 1 ? '' : 's'}
          {totalAssayed > 0
            ? ` · ${totalAssayed} with producer assay data`
            : ''}
        </p>
      </header>

      <FilterBar filters={filters} regions={regions} />

      {grades.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-muted)]/30 text-xs text-[color:var(--color-muted-foreground)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Grade</th>
                <th className="px-3 py-2 text-left font-medium">Origin</th>
                <th className="px-3 py-2 text-left font-medium">Region</th>
                <th className="px-3 py-2 text-right font-medium">API</th>
                <th className="px-3 py-2 text-right font-medium">Sulfur %</th>
                <th className="px-3 py-2 text-right font-medium">TAN</th>
                <th className="px-3 py-2 text-left font-medium">vs marker</th>
                <th className="px-3 py-2 text-right font-medium">Assays</th>
              </tr>
            </thead>
            <tbody>
              {grades.map((g) => (
                <GradeRow key={g.slug} grade={g} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function FilterBar({
  filters,
  regions,
}: {
  filters: {
    search?: string;
    region?: string;
    sweetOnly?: boolean;
    lightOnly?: boolean;
    markerFilter?: 'marker' | 'non-marker';
  };
  regions: string[];
}) {
  return (
    <form
      method="GET"
      action="/crudes"
      className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-3 py-2"
    >
      <input
        type="search"
        name="search"
        placeholder="Search grades…"
        defaultValue={filters.search ?? ''}
        className="min-w-[10rem] flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm placeholder:text-[color:var(--color-muted-foreground)]"
      />
      <select
        name="region"
        defaultValue={filters.region ?? ''}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
      >
        <option value="">All regions</option>
        {regions.map((r) => (
          <option key={r} value={r}>
            {prettyRegion(r)}
          </option>
        ))}
      </select>
      <select
        name="marker"
        defaultValue={filters.markerFilter ?? ''}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm"
      >
        <option value="">All grades</option>
        <option value="marker">Markers only</option>
        <option value="non-marker">Non-markers only</option>
      </select>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          name="sweet"
          value="1"
          defaultChecked={filters.sweetOnly}
        />
        Sweet (&lt; 0.5% S)
      </label>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          name="light"
          value="1"
          defaultChecked={filters.lightOnly}
        />
        Light (≥ 35° API)
      </label>
      <button
        type="submit"
        className="rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-foreground)] hover:opacity-90"
      >
        Filter
      </button>
      {(filters.search ||
        filters.region ||
        filters.sweetOnly ||
        filters.lightOnly ||
        filters.markerFilter) && (
        <Link
          href="/crudes"
          className="text-xs text-[color:var(--color-muted-foreground)] hover:underline"
        >
          Reset
        </Link>
      )}
    </form>
  );
}

function GradeRow({ grade }: { grade: CrudeGradeIndexRow }) {
  return (
    <tr className="border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-muted)]/20">
      <td className="px-3 py-2">
        <Link
          href={`/crudes/${grade.slug}`}
          className="flex items-center gap-1.5 font-medium hover:underline"
        >
          {grade.name}
          {grade.isMarker ? (
            <span className="rounded-full bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[color:var(--color-accent)]">
              marker
            </span>
          ) : null}
          {grade.characterization ? (
            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
              {grade.characterization}
            </span>
          ) : null}
        </Link>
      </td>
      <td className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
        {grade.originCountry ?? '—'}
      </td>
      <td className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
        {grade.region ? prettyRegion(grade.region) : '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {grade.apiGravity?.toFixed(1) ?? '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {grade.sulfurPct?.toFixed(2) ?? '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-xs">
        {grade.tan?.toFixed(2) ?? '—'}
      </td>
      <td className="px-3 py-2 text-xs">
        {grade.markerSlug ? (
          <span>
            <span className="font-medium uppercase">{grade.markerSlug}</span>
            {grade.differentialUsdPerBbl != null ? (
              <span className="ml-1 text-[color:var(--color-muted-foreground)]">
                {grade.differentialUsdPerBbl >= 0 ? '+' : ''}
                ${grade.differentialUsdPerBbl.toFixed(2)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-xs">
        {grade.assayCount > 0 ? (
          <span
            className="rounded-full bg-[color:var(--color-muted)]/40 px-1.5 py-0.5 tabular-nums"
            title={`${grade.assayCount} producer assay${grade.assayCount === 1 ? '' : 's'} linked`}
          >
            {grade.assayCount}
          </span>
        ) : (
          <span className="text-[color:var(--color-muted-foreground)]">—</span>
        )}
      </td>
    </tr>
  );
}

function EmptyState() {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-muted)]/10 px-4 py-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
      No grades match the current filters.{' '}
      <Link href="/crudes" className="text-[color:var(--color-accent)] hover:underline">
        Reset
      </Link>
      .
    </div>
  );
}

function prettyRegion(slug: string): string {
  return slug
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}
