import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listCrudeGrades,
  listTopKnownEntityTagsByPrefix,
  lookupKnownEntities,
  type CrudeGradeRow,
} from '@procur/catalog';
import { KycBadge } from '../../../components/KycBadge';
import { MapViewClient } from './_components/MapViewClient';
import type { MapEntity } from './_components/MapView';

/**
 * Known-entities rolodex page — analyst-curated buyers / sellers /
 * traders / refiners. Distinct from the awards-driven supplier-graph
 * pages: this surfaces entities that may have ZERO public-tender
 * activity, like private Mediterranean refiners or major commodity
 * trading houses.
 *
 * URL params drive filters (server-side, no client state):
 *   ?category=crude-oil
 *   ?country=IT
 *   ?role=refiner|trader|producer|state-buyer|power-plant
 *   ?tag=region:mediterranean | compatible:es-sider | …
 */
export const dynamic = 'force-dynamic';

const CATEGORY_OPTIONS = [
  'all',
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'lpg',
  'marine-bunker',
  'food-commodities',
] as const;

const ROLE_OPTIONS = [
  { value: '', label: 'all' },
  { value: 'refiner', label: 'refiners' },
  { value: 'trader', label: 'traders' },
  { value: 'producer', label: 'producers' },
  { value: 'state-buyer', label: 'state buyers' },
  { value: 'power-plant', label: 'power plants' },
  // Environmental services rolodex per
  // docs/environmental-services-rolodex-brief.md. Empty until the
  // Phase 1 / Phase 2 ingestion runs — chip is visible regardless
  // so the surface is discoverable from day 1.
  { value: 'environmental-services', label: 'env services' },
];

/**
 * Free-text tag chips that don't slot into a structured filter
 * (region:, compatible:, source:, status:, etc.). These are the
 * historical analyst-curated capability flags — kept hardcoded
 * because they're a deliberate analyst vocabulary, not a discovered
 * one. Add as new analyst-meaningful flags emerge.
 */
const TAG_QUICK_FILTERS = [
  'public-tender-visible',
  'libya-historic',
  'sweet-crude-runner',
  'top-tier',
];

/** Pretty-label a `region:` tag — strip the prefix and humanize. */
function labelRegionTag(tag: string): string {
  return tag.replace(/^region:/, '').replace(/-/g, ' ');
}

/** Pretty-label a crude grade for the chip (Name + ISO origin). */
function labelGradeChip(grade: CrudeGradeRow): string {
  return grade.originCountry
    ? `${grade.name} (${grade.originCountry})`
    : grade.name;
}

/** Group crude grades by region for the chip wall. Grades without
 *  a region land in "Other". Region order is the natural taxonomy
 *  order from `crude_grades.region` (alphabetical at write time). */
function groupGradesByRegion(grades: CrudeGradeRow[]): Array<{
  region: string;
  grades: CrudeGradeRow[];
}> {
  const buckets = new Map<string, CrudeGradeRow[]>();
  for (const g of grades) {
    const key = g.region ?? 'Other';
    const list = buckets.get(key) ?? [];
    list.push(g);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === 'Other') return 1;
      if (b === 'Other') return -1;
      return a.localeCompare(b);
    })
    .map(([region, grades]) => ({
      region,
      grades: grades.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

interface Props {
  searchParams: Promise<{
    category?: string;
    country?: string;
    role?: string;
    tag?: string;
    q?: string;
    view?: string;
    approval?: string;
  }>;
}

const APPROVAL_FILTERS = [
  { value: '', label: 'all' },
  { value: 'approved', label: 'approved' },
  { value: 'pending', label: 'pending' },
  { value: 'expired', label: 'expired' },
  { value: 'rejected', label: 'rejected' },
  { value: 'none', label: 'not engaged' },
] as const;
type ApprovalFilter = 'approved' | 'pending' | 'rejected' | 'expired' | 'none';

const VALID_APPROVAL_FILTERS: readonly ApprovalFilter[] = [
  'approved',
  'pending',
  'rejected',
  'expired',
  'none',
];

function parseApprovalFilter(s: string | undefined): ApprovalFilter | undefined {
  if (!s) return undefined;
  return (VALID_APPROVAL_FILTERS as readonly string[]).includes(s)
    ? (s as ApprovalFilter)
    : undefined;
}

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/** ISO-2 → full English country name; falls back to the ISO code on
 *  unknown values (private orgs, "XX" sentinel). */
function formatCountry(iso2: string): string {
  try {
    return REGION_NAMES.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
}

/**
 * Split the `·`-joined notes string into structured key/value pairs.
 * Drops `Source: …` lines (analyst-irrelevant); leaves anything that
 * doesn't follow the `Key: value` pattern as a free-text line.
 */
function parseNotes(
  notes: string | null,
): { kind: 'kv'; key: string; value: string }[] | null {
  if (!notes) return null;
  // Top-level split is `·` only. `|` is sometimes used inside a single
  // field's value (e.g. Fuel: A | B), so splitting on it would shred
  // those values into pseudo-rows.
  const segments = notes
    .split(/\s+·\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kv: { kind: 'kv'; key: string; value: string }[] = [];
  for (const seg of segments) {
    if (/^Source:/i.test(seg)) continue;
    const m = seg.match(/^([A-Za-z][A-Za-z _-]{0,30}?):\s*(.+)$/);
    if (m) {
      kv.push({ kind: 'kv', key: m[1]!.trim(), value: m[2]!.trim() });
    } else {
      kv.push({ kind: 'kv', key: '', value: seg });
    }
  }
  return kv.length > 0 ? kv : null;
}

/**
 * Strip a trailing "(Country Name)" or "(XX)" from a value when it
 * matches the row's country. The screenshot shows every Afghan power
 * plant's Owner / Parent fields ending in "(Afghanistan)" — that's
 * already conveyed by the country section header.
 */
function stripCountrySuffix(value: string, country: string): string {
  const fullName = formatCountry(country);
  return value
    .replace(new RegExp(`\\s*\\(${escapeRegex(fullName)}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s*\\(${escapeRegex(country)}\\)\\s*$`, 'i'), '')
    .trim();
}

/** Strip "[100%]" / "[100.0%]" ownership-percent suffixes — visually
 *  noisy and almost always 100 for the rolodex's analyst-curated rows. */
function stripOwnershipPct(value: string): string {
  return value.replace(/\s*\[\d+(?:\.\d+)?%\]\s*$/, '').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize a Fuel: value: drop GEM taxonomy prefixes ("fossil gas:",
 *  "fossil liquids:"), normalize separators, dedupe — so what was
 *  "fossil gas: natural gas, fossil liquids: fuel oil" becomes
 *  "natural gas, fuel oil". */
function normalizeFuel(value: string): string {
  const parts = value
    .split(/\s*[|,]\s*/)
    .map((p) => p.replace(/^(?:fossil\s+(?:gas|liquids))\s*:\s*/i, '').trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(', ');
}

/** Pull (capacity, fuel, started, status) out of a note kv list and
 *  return the compact stats line + the remaining kv pairs (operator,
 *  owner, parent, contact, free-text — whatever's left). */
function extractPlantStats(
  noteKv: { kind: 'kv'; key: string; value: string }[],
): {
  stats: string | null;
  remaining: { kind: 'kv'; key: string; value: string }[];
} {
  const STATS_KEYS = new Set(['capacity', 'fuel', 'started', 'status']);
  const taken = new Map<string, string>();
  const remaining: { kind: 'kv'; key: string; value: string }[] = [];
  for (const kv of noteKv) {
    const k = kv.key.toLowerCase();
    if (STATS_KEYS.has(k) && !taken.has(k)) {
      taken.set(k, kv.value);
    } else {
      remaining.push(kv);
    }
  }
  const parts: string[] = [];
  const cap = taken.get('capacity');
  if (cap) parts.push(cap);
  const fuel = taken.get('fuel');
  if (fuel) parts.push(normalizeFuel(fuel));
  const started = taken.get('started');
  if (started) parts.push(started);
  const status = taken.get('status');
  if (status) parts.push(status);
  return { stats: parts.length ? parts.join(' · ') : null, remaining };
}

/** Drop redundant Owner / Parent rows: if Operator == Owner == Parent,
 *  collapse to just Operator. If Owner == Parent, drop Parent. Values
 *  are first normalized (country suffix + ownership% stripped). */
function collapseOwnership(
  noteKv: { kind: 'kv'; key: string; value: string }[],
  country: string,
): { kind: 'kv'; key: string; value: string }[] {
  const norm = (v: string) => stripOwnershipPct(stripCountrySuffix(v, country));
  const out: { kind: 'kv'; key: string; value: string }[] = [];
  let lastOwnerNorm: string | null = null;
  for (const kv of noteKv) {
    const k = kv.key.toLowerCase();
    const normalized = norm(kv.value);
    if (k === 'operator' || k === 'owner' || k === 'parent') {
      if (lastOwnerNorm === normalized) continue; // dedupe consecutive identical owners
      lastOwnerNorm = normalized;
      out.push({ ...kv, value: normalized });
    } else {
      out.push({ ...kv, value: normalized });
    }
  }
  return out;
}

/** Tags that duplicate info already shown elsewhere in the row.
 *  Hidden from the Tags column but still queryable by URL. */
const ROLE_TAG_SET = new Set([
  'refiner',
  'refinery',
  'trader',
  'producer',
  'state-buyer',
  'power-plant',
  'environmental-services',
]);
function isNoiseTag(t: string): boolean {
  if (ROLE_TAG_SET.has(t)) return true;
  if (t.startsWith('source:')) return true; // ingest provenance — not analyst-meaningful
  if (t.startsWith('size:')) return true; // shown in stats
  if (t.startsWith('status:')) return true; // shown in stats
  if (t.startsWith('fuel:')) return true; // shown in stats
  return false;
}

export default async function KnownEntitiesPage({ searchParams }: Props) {
  const { category, country, role, tag, q, view, approval } = await searchParams;
  const categoryTag = category && category !== 'all' ? category : undefined;
  const nameQuery = q?.trim() || undefined;
  const activeView: 'list' | 'map' = view === 'map' ? 'map' : 'list';
  const approvalFilter = parseApprovalFilter(approval);

  // Per-tenant approval state: requires the company id, so resolve
  // the auth context here (the rolodex is an authenticated surface).
  const { company } = await requireCompany();

  // The full rolodex is currently a few thousand rows and growing
  // (refiners + traders + producers + power plants + env-services
  // ingest). 50k ceiling matches the lookupKnownEntities upper bound
  // so the page is effectively uncapped for browsing — the previous
  // 2k list cap was tripping the "capped, narrow filters" UI for
  // normal use. The "capped" message still appears if the response
  // genuinely hits 50k, which would be a real signal to paginate.
  const queryLimit = 50_000;
  const [rows, allCrudeGrades, regionTags] = await Promise.all([
    lookupKnownEntities({
      categoryTag,
      country: country?.trim() || undefined,
      role: role?.trim() || undefined,
      tag: tag?.trim() || undefined,
      name: nameQuery,
      companyId: company.id,
      approvalStatus: approvalFilter,
      limit: queryLimit,
    }),
    // All crude grades, used to render the Crude grade chip wall
    // grouped by origin region. Cheap (<50 rows in v1).
    listCrudeGrades(),
    // Top region:* tags actually present in the rolodex — drives the
    // Region filter row data-first instead of a hardcoded list.
    listTopKnownEntityTagsByPrefix('region:', 12),
  ]);
  const gradesByRegion = groupGradesByRegion(allCrudeGrades);
  const truncated = rows.length === queryLimit;

  // Group by country for at-a-glance scanning.
  const byCountry = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byCountry.get(r.country) ?? [];
    list.push(r);
    byCountry.set(r.country, list);
  }
  // Sort by full country name so "United Arab Emirates" lands near U,
  // not at the top under "AE".
  const countries = [...byCountry.keys()].sort((a, b) =>
    formatCountry(a).localeCompare(formatCountry(b)),
  );

  const baseHref = (
    override: Partial<{
      category: string;
      country: string;
      role: string;
      tag: string;
      q: string;
      view: string;
      approval: string;
    }>,
  ) => {
    const next = new URLSearchParams();
    const cat = override.category ?? category ?? 'all';
    if (cat && cat !== 'all') next.set('category', cat);
    const c = override.country ?? country;
    if (c) next.set('country', c);
    const r = override.role ?? role;
    if (r) next.set('role', r);
    const t = override.tag ?? tag;
    if (t) next.set('tag', t);
    const qNext = override.q ?? q;
    if (qNext) next.set('q', qNext);
    const v = override.view ?? activeView;
    if (v && v !== 'list') next.set('view', v);
    const a = override.approval ?? approvalFilter ?? '';
    if (a) next.set('approval', a);
    const qs = next.toString();
    return qs ? `/suppliers/known-entities?${qs}` : '/suppliers/known-entities';
  };

  // Active-filter chips: one per non-default filter, with × to clear
  // that single filter. The chip click target navigates to the same
  // page with that param dropped.
  const activeFilters: Array<{ key: string; label: string; clearHref: string }> = [];
  if (nameQuery) {
    activeFilters.push({
      key: 'q',
      label: `Name: ${nameQuery}`,
      clearHref: baseHref({ q: '' }),
    });
  }
  if (categoryTag) {
    activeFilters.push({
      key: 'category',
      label: `Category: ${categoryTag}`,
      clearHref: baseHref({ category: 'all' }),
    });
  }
  if (country) {
    activeFilters.push({
      key: 'country',
      label: `Country: ${formatCountry(country)}`,
      clearHref: baseHref({ country: '' }),
    });
  }
  if (role) {
    const roleLabel = ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
    activeFilters.push({
      key: 'role',
      label: `Role: ${roleLabel}`,
      clearHref: baseHref({ role: '' }),
    });
  }
  if (tag) {
    let tagLabel = tag;
    if (tag.startsWith('compatible:')) {
      const slug = tag.slice('compatible:'.length);
      const grade = allCrudeGrades.find((g) => g.slug === slug);
      tagLabel = grade ? `Compatible: ${labelGradeChip(grade)}` : tag;
    } else if (tag.startsWith('region:')) {
      tagLabel = `Region: ${labelRegionTag(tag)}`;
    }
    activeFilters.push({
      key: 'tag',
      label: tag.startsWith('compatible:') || tag.startsWith('region:')
        ? tagLabel
        : `Tag: ${tagLabel}`,
      clearHref: baseHref({ tag: '' }),
    });
  }
  if (approvalFilter) {
    const approvalLabel =
      APPROVAL_FILTERS.find((f) => f.value === approvalFilter)?.label ?? approvalFilter;
    activeFilters.push({
      key: 'approval',
      label: `Approval: ${approvalLabel}`,
      clearHref: baseHref({ approval: '' }),
    });
  }

  const mapEntities: MapEntity[] = rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      country: r.country,
      role: r.role,
      categories: r.categories,
      tags: r.tags,
      notes: r.notes,
      metadata: r.metadata,
      latitude: r.latitude as number,
      longitude: r.longitude as number,
    }));

  const containerClass =
    activeView === 'map'
      ? 'mx-auto max-w-screen-2xl px-4 py-6'
      : 'mx-auto max-w-6xl px-6 py-10';

  // When filtered to a single role, the Role column repeats N times —
  // hide it.
  const showRoleColumn = !role;

  return (
    <div className={containerClass}>
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/suppliers/intelligence" className="hover:text-[color:var(--color-foreground)]">
          ← Intelligence
        </Link>
        {' · '}
        <Link href="/suppliers/reverse-search" className="hover:text-[color:var(--color-foreground)]">
          Reverse search
        </Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Known entities</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Analyst-curated rolodex — buyers, sellers, refiners, and trading houses VTC has researched
          as relevant to its deal flow. Includes entities with no public-tender activity (private
          refiners, trading houses) that the supplier-graph queries can&apos;t see.
        </p>
      </header>

      <section className="mb-6 space-y-3 text-xs">
        {/* Always-visible top row: name search + active filters + the
            full-filters disclosure trigger. The full chip walls live
            inside <details> so the page stays scannable when nothing
            is selected. */}
        <div className="flex flex-wrap items-center gap-2">
          <form
            action="/suppliers/known-entities"
            method="get"
            className="flex items-center gap-1"
          >
            {/* Hidden inputs preserve every other active filter on
                submit so search doesn't wipe out the rest of the
                URL state. */}
            {category && category !== 'all' && (
              <input type="hidden" name="category" value={category} />
            )}
            {country && <input type="hidden" name="country" value={country} />}
            {role && <input type="hidden" name="role" value={role} />}
            {tag && <input type="hidden" name="tag" value={tag} />}
            {approvalFilter && (
              <input type="hidden" name="approval" value={approvalFilter} />
            )}
            {activeView !== 'list' && (
              <input type="hidden" name="view" value={activeView} />
            )}
            <input
              type="search"
              name="q"
              defaultValue={nameQuery ?? ''}
              placeholder="Search name…"
              className="w-48 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs outline-none placeholder:text-[color:var(--color-muted-foreground)] focus:border-[color:var(--color-foreground)]/50"
            />
          </form>

          {activeFilters.map((f) => (
            <Link
              key={f.key}
              href={f.clearHref}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 px-2 py-1 hover:bg-[color:var(--color-muted)]"
              title={`Clear ${f.key}`}
            >
              <span>{f.label}</span>
              <span aria-hidden="true" className="text-[color:var(--color-muted-foreground)]">
                ×
              </span>
            </Link>
          ))}
          {activeFilters.length > 1 && (
            <Link
              href="/suppliers/known-entities"
              className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
            >
              clear all
            </Link>
          )}

          {/* Disclosure trigger lives at the right edge of the same
              row when there's space, drops to next line when it
              wraps. */}
          <details className="group ml-auto">
            <summary className="cursor-pointer list-none rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:border-[color:var(--color-foreground)]">
              <span>Filters</span>
              <span
                aria-hidden="true"
                className="ml-1 inline-block transition-transform group-open:rotate-180"
              >
                ▾
              </span>
            </summary>
            {/* Panel rendered as a sibling block. Tailwind doesn't
                surface a `details[open]` selector so we use the
                `group-open:` variant on the trigger for the chevron
                and rely on details' native open/close for the panel.
                The panel is INSIDE <details> so it's only in the DOM
                when expanded. */}
            <div className="mt-3 space-y-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-3">
              <FilterRow label="Category">
                {CATEGORY_OPTIONS.map((c) => (
                  <FilterChip
                    key={c}
                    href={baseHref({ category: c })}
                    active={(category ?? 'all') === c}
                    label={c}
                  />
                ))}
              </FilterRow>
              <FilterRow label="Role">
                {ROLE_OPTIONS.map((r) => (
                  <FilterChip
                    key={r.value}
                    href={baseHref({ role: r.value })}
                    active={(role ?? '') === r.value}
                    label={r.label}
                  />
                ))}
              </FilterRow>
              <FilterRow label="Region">
                {regionTags.length === 0 ? (
                  <span className="text-[color:var(--color-muted-foreground)]">
                    no region:* tags in rolodex yet
                  </span>
                ) : (
                  regionTags.map((rt) => (
                    <FilterChip
                      key={rt.tag}
                      href={baseHref({ tag: rt.tag })}
                      active={tag === rt.tag}
                      label={`${labelRegionTag(rt.tag)} · ${rt.count}`}
                      title={rt.tag}
                    />
                  ))
                )}
              </FilterRow>
              {gradesByRegion.map(({ region, grades }) => (
                <FilterRow
                  key={`grade-${region}`}
                  label={
                    region === gradesByRegion[0]?.region
                      ? `Crude grade · ${region}`
                      : region
                  }
                >
                  {grades.map((g) => {
                    const compat = `compatible:${g.slug}`;
                    return (
                      <FilterChip
                        key={g.slug}
                        href={baseHref({ tag: compat })}
                        active={tag === compat}
                        label={labelGradeChip(g)}
                        title={compat}
                      />
                    );
                  })}
                </FilterRow>
              ))}
              <FilterRow label="Tags">
                {TAG_QUICK_FILTERS.map((t) => (
                  <FilterChip
                    key={t}
                    href={baseHref({ tag: t })}
                    active={tag === t}
                    label={t}
                  />
                ))}
              </FilterRow>
              <FilterRow label="Approval">
                {APPROVAL_FILTERS.map((f) => (
                  <FilterChip
                    key={f.value || 'all'}
                    href={baseHref({ approval: f.value })}
                    active={(approvalFilter ?? '') === f.value}
                    label={f.label}
                  />
                ))}
              </FilterRow>
            </div>
          </details>
        </div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          <span className="font-medium text-[color:var(--color-foreground)] tabular-nums">
            {rows.length.toLocaleString()}
            {truncated ? '+' : ''}
          </span>{' '}
          {rows.length === 1 ? 'entity' : 'entities'}
          {truncated && (
            <span className="ml-2 text-xs">
              (capped — narrow filters to see all)
            </span>
          )}
        </p>
        <div className="flex gap-1 text-xs">
          <Link
            href={baseHref({ view: 'list' })}
            className={`rounded-[var(--radius-sm)] border px-3 py-1 hover:border-[color:var(--color-foreground)] ${
              activeView === 'list'
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                : 'border-[color:var(--color-border)]'
            }`}
          >
            List
          </Link>
          <Link
            href={baseHref({ view: 'map' })}
            className={`rounded-[var(--radius-sm)] border px-3 py-1 hover:border-[color:var(--color-foreground)] ${
              activeView === 'map'
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                : 'border-[color:var(--color-border)]'
            }`}
          >
            Map
          </Link>
        </div>
      </div>

      {activeView === 'map' ? (
        <MapViewClient entities={mapEntities} totalCount={rows.length} />
      ) : rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No entities match these filters. Try widening the category or clearing tags.
        </div>
      ) : (
        countries.map((c) => {
          const groupRows = byCountry.get(c)!;
          // Hide the Tags column for this country group when nothing
          // visible would render in it — the column was wasting space
          // for power-plant-heavy countries where every tag is
          // role/size/status (all suppressed by isNoiseTag).
          const groupHasTags = groupRows.some(
            (e) => e.tags.filter((t) => !isNoiseTag(t)).length > 0,
          );
          // Per-group role breakdown rendered next to the country
          // header — answers "what kind of entities are in this
          // country" without having to scan the Role column.
          const roleCounts = new Map<string, number>();
          for (const e of groupRows) {
            roleCounts.set(e.role, (roleCounts.get(e.role) ?? 0) + 1);
          }
          const roleBreakdown = [...roleCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `${n} ${r}${n === 1 ? '' : 's'}`)
            .join(' · ');
          return (
            <section key={c} className="mb-6">
              <h2 className="mb-2 flex items-baseline gap-2 text-sm font-medium tracking-tight">
                <span>{formatCountry(c)}</span>
                <span className="font-mono text-[10px] uppercase text-[color:var(--color-muted-foreground)]">
                  {c}
                </span>
                <span className="text-xs font-normal text-[color:var(--color-muted-foreground)]">
                  · {roleBreakdown}
                </span>
              </h2>
              <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                    <tr>
                      <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Name
                      </th>
                      {showRoleColumn && (
                        <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                          Role
                        </th>
                      )}
                      <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Notes
                      </th>
                      {groupHasTags && (
                        <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                          Tags
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((e) => {
                      const rawNoteKv = parseNotes(e.notes);
                      const noteKv = rawNoteKv ? collapseOwnership(rawNoteKv, e.country) : null;
                      // Power plants share a uniform shape (capacity,
                      // fuel, started, status); render those as a
                      // single-line stats string and keep the residual
                      // kv pairs (operator, owner) below.
                      const isPlant = e.role === 'power-plant';
                      const { stats, remaining } =
                        isPlant && noteKv
                          ? extractPlantStats(noteKv)
                          : { stats: null, remaining: noteKv ?? [] };
                      const visibleTags = e.tags.filter((t) => !isNoiseTag(t));
                      return (
                        <tr
                          key={e.id}
                          className="border-b border-[color:var(--color-border)] last:border-b-0"
                        >
                          <td className="px-3 py-2 align-top">
                            <Link
                              href={`/entities/${encodeURIComponent(e.slug)}`}
                              className="font-medium hover:underline"
                            >
                              {e.name}
                            </Link>
                            {e.approvalStatus && (
                              <>
                                {' '}
                                <KycBadge
                                  status={e.approvalStatus}
                                  expiresAt={e.approvalExpiresAt}
                                />
                              </>
                            )}
                            {e.aliases.length > 1 && (
                              <div className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                                aka {e.aliases.filter((a) => a !== e.name).slice(0, 2).join(', ')}
                              </div>
                            )}
                          </td>
                          {showRoleColumn && (
                            <td className="px-3 py-2 align-top text-[color:var(--color-muted-foreground)]">
                              {e.role}
                            </td>
                          )}
                          <td className="px-3 py-2 align-top">
                            {stats && (
                              <div className="text-sm tabular-nums">{stats}</div>
                            )}
                            {remaining.length === 0 && !stats && (
                              <span className="text-[color:var(--color-muted-foreground)]">—</span>
                            )}
                            {remaining.length > 0 && (
                              <dl className={`space-y-0.5 ${stats ? 'mt-1' : ''}`}>
                                {remaining.slice(0, 4).map((kv, i) => (
                                  <div
                                    key={i}
                                    className="flex flex-wrap gap-1 leading-snug"
                                  >
                                    {kv.key && (
                                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                                        {kv.key}:
                                      </dt>
                                    )}
                                    <dd className="text-sm">{kv.value}</dd>
                                  </div>
                                ))}
                                {remaining.length > 4 && (
                                  <div className="text-[11px] text-[color:var(--color-muted-foreground)]">
                                    +{remaining.length - 4} more
                                  </div>
                                )}
                              </dl>
                            )}
                            {e.contactEntity && (
                              <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                                Contact: {e.contactEntity}
                              </div>
                            )}
                          </td>
                          {groupHasTags && (
                            <td className="px-3 py-2 align-top">
                              <div className="flex flex-wrap gap-1">
                                {visibleTags.slice(0, 5).map((t) => (
                                  <Link
                                    key={t}
                                    href={baseHref({ tag: t })}
                                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-xs hover:border-[color:var(--color-foreground)]"
                                  >
                                    {t}
                                  </Link>
                                ))}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Curated by analyst research + augmented from Wikidata, GEM, Wikipedia, OSM, and FracTracker.
        Slate compatibility (<code>compatible:&lt;grade&gt;</code> tags) is analyst-curated. Not a
        substitute for customs / AIS data when current import flows matter.
      </footer>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-20 text-[color:var(--color-muted-foreground)]">{label}:</span>
      {children}
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  title,
}: {
  href: string;
  active: boolean;
  label: string;
  title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
        active
          ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
          : 'border-[color:var(--color-border)]'
      }`}
    >
      {label}
    </Link>
  );
}
