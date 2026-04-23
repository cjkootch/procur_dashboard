import Link from 'next/link';
import type { Metadata } from 'next';
import {
  listActiveCategories,
  listJurisdictions,
  listOpportunities,
  type OpportunitySort,
} from '../../lib/queries';
import { OpportunityCard } from '../../components/opportunity-card';
import { Pagination } from '../../components/pagination';
import { SearchBar } from '../../components/search-bar';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const q = getOne(sp.q);
  const jurisdiction = getOne(sp.jurisdiction);
  const category = getOne(sp.category);

  const parts = ['Opportunities'];
  if (q) parts.push(`matching "${q}"`);
  if (jurisdiction) parts.push(`in ${jurisdiction}`);
  if (category) parts.push(`in ${category}`);

  return {
    title: parts.join(' '),
    description:
      'Browse active government tenders across the Caribbean, Latin America, and Africa — filter by jurisdiction, category, value, and deadline.',
  };
}

function getOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function toInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function isSort(v: string | undefined): v is OpportunitySort {
  return (
    v === 'deadline-asc' || v === 'deadline-desc' || v === 'value-desc' || v === 'recent'
  );
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = getOne(sp.q);
  const jurisdiction = getOne(sp.jurisdiction);
  const category = getOne(sp.category);
  const minValueUsd = toInt(getOne(sp.minValue));
  const maxValueUsd = toInt(getOne(sp.maxValue));
  const page = toInt(getOne(sp.page)) ?? 1;
  const sortRaw = getOne(sp.sort);
  const sort: OpportunitySort = isSort(sortRaw) ? sortRaw : 'deadline-asc';

  const perPage = 24;

  const [{ rows, total }, categories, allJurisdictions] = await Promise.all([
    listOpportunities({
      q,
      jurisdiction,
      category,
      minValueUsd,
      maxValueUsd,
      page,
      perPage,
      sort,
    }),
    listActiveCategories(),
    listJurisdictions(),
  ]);

  const buildHref = (nextParams: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    const merged = {
      q,
      jurisdiction,
      category,
      minValue: minValueUsd,
      maxValue: maxValueUsd,
      sort: sort === 'deadline-asc' ? undefined : sort,
      page: page === 1 ? undefined : page,
      ...nextParams,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v != null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    return `/opportunities${qs ? `?${qs}` : ''}`;
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Opportunities</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {total.toLocaleString()} active tenders across {allJurisdictions.length} jurisdictions.
        </p>
      </header>

      <div className="mb-6">
        <SearchBar defaultQuery={q} placeholder="Search by keyword, reference, or agency" />
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside className="space-y-6 text-sm">
          <FilterGroup title="Jurisdiction">
            <FilterLink href={buildHref({ jurisdiction: undefined, page: undefined })} active={!jurisdiction}>
              All
            </FilterLink>
            {allJurisdictions
              .filter((j) => j.active)
              .map((j) => (
                <FilterLink
                  key={j.slug}
                  href={buildHref({ jurisdiction: j.slug, page: undefined })}
                  active={jurisdiction === j.slug}
                >
                  {j.name}
                </FilterLink>
              ))}
          </FilterGroup>

          <FilterGroup title="Category">
            <FilterLink href={buildHref({ category: undefined, page: undefined })} active={!category}>
              All
            </FilterLink>
            {categories
              .filter((c) => !c.parentSlug)
              .map((c) => (
                <FilterLink
                  key={c.slug}
                  href={buildHref({ category: c.slug, page: undefined })}
                  active={category === c.slug}
                >
                  {c.name}
                </FilterLink>
              ))}
          </FilterGroup>

          <FilterGroup title="Value (USD)">
            <ValueFilter buildHref={buildHref} current={{ minValueUsd, maxValueUsd }} />
          </FilterGroup>

          <FilterGroup title="Sort">
            <SortLink buildHref={buildHref} value="deadline-asc" current={sort}>
              Closing soon
            </SortLink>
            <SortLink buildHref={buildHref} value="value-desc" current={sort}>
              Highest value
            </SortLink>
            <SortLink buildHref={buildHref} value="recent" current={sort}>
              Most recent
            </SortLink>
            <SortLink buildHref={buildHref} value="deadline-desc" current={sort}>
              Closing latest
            </SortLink>
          </FilterGroup>
        </aside>

        <section>
          {rows.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
              <p className="font-medium">No opportunities match your filters</p>
              <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                Try clearing filters or{' '}
                <Link className="underline" href="/opportunities">
                  browse all
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {rows.map((op) => (
                  <OpportunityCard key={op.id} op={op} />
                ))}
              </div>
              <Pagination
                page={page}
                perPage={perPage}
                total={total}
                buildHref={(p) => buildHref({ page: p })}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 font-medium text-[color:var(--color-foreground)]">{title}</p>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-[var(--radius-sm)] px-2 py-1 text-sm ${
        active
          ? 'bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
          : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
      }`}
    >
      {children}
    </Link>
  );
}

function SortLink({
  value,
  current,
  buildHref,
  children,
}: {
  value: OpportunitySort;
  current: OpportunitySort;
  buildHref: (next: Record<string, string | number | undefined>) => string;
  children: React.ReactNode;
}) {
  return (
    <FilterLink href={buildHref({ sort: value, page: undefined })} active={current === value}>
      {children}
    </FilterLink>
  );
}

function ValueFilter({
  buildHref,
  current,
}: {
  buildHref: (next: Record<string, string | number | undefined>) => string;
  current: { minValueUsd?: number; maxValueUsd?: number };
}) {
  const ranges: Array<{ label: string; min?: number; max?: number }> = [
    { label: 'Any' },
    { label: 'Under $100K', max: 100_000 },
    { label: '$100K – $1M', min: 100_000, max: 1_000_000 },
    { label: '$1M – $10M', min: 1_000_000, max: 10_000_000 },
    { label: 'Over $10M', min: 10_000_000 },
  ];
  return (
    <>
      {ranges.map((r) => {
        const active =
          (current.minValueUsd ?? undefined) === r.min &&
          (current.maxValueUsd ?? undefined) === r.max;
        return (
          <FilterLink
            key={r.label}
            href={buildHref({
              minValue: r.min,
              maxValue: r.max,
              page: undefined,
            })}
            active={active}
          >
            {r.label}
          </FilterLink>
        );
      })}
    </>
  );
}
