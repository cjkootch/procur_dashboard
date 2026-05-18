import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listCrudeGrades,
  listTopKnownEntityTagsByPrefix,
  lookupKnownEntities,
  type CrudeGradeRow,
} from '@procur/catalog';
import { EntityAvatar } from '../../../components/EntityAvatar';
import { KycBadge } from '../../../components/KycBadge';
import { MapViewClient } from './_components/MapViewClient';
import type { MapEntity } from './_components/MapView';
import { lookupCountryCentroid } from '../../../lib/known-entity-centroids';
import { smartSearchAction } from './actions';

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
  // docs/environmental-services-rolodex-brief.md.
  { value: 'environmental-services', label: 'env services' },
  // Caribbean fuel buyer rolodex per
  // docs/caribbean-fuel-buyer-brief.md. Demand-side coverage for
  // refined fuel — utilities, mining, marine bunker, aviation,
  // industrial distributors, government fleets, hospitality,
  // agriculture, LPG distributors.
  { value: 'fuel-buyer-industrial', label: 'fuel buyers' },
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
    /** Original NL query echoed back by smartSearchAction. Drives the
     *  "Interpreted as …" banner so the operator can see what the LLM
     *  picked + revert if it misread. */
    smart?: string;
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
  'fuel-buyer-industrial',
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
  const { category, country, role, tag, q, view, approval, smart } =
    await searchParams;
  const categoryTag = category && category !== 'all' ? category : undefined;
  const nameQuery = q?.trim() || undefined;
  const smartQuery = smart?.trim() || undefined;
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
      smart: string;
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
    const s = override.smart ?? smart;
    if (s) next.set('smart', s);
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

  // Rows with precise coordinates render at their exact location;
  // rows missing coordinates render at the country centroid with an
  // "approximate" marker style so they stay visible on the map. This
  // closes the gap where chat-auto-added entities (which rarely have
  // lat/lng handy) silently disappeared from the map view.
  const mapEntities: MapEntity[] = rows.flatMap((r) => {
    if (r.latitude != null && r.longitude != null) {
      return [
        {
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
        },
      ];
    }
    const centroid = lookupCountryCentroid(r.country);
    if (!centroid) return [];
    return [
      {
        slug: r.slug,
        name: r.name,
        country: r.country,
        role: r.role,
        categories: r.categories,
        tags: r.tags,
        notes: r.notes,
        metadata: r.metadata,
        latitude: centroid.latitude,
        longitude: centroid.longitude,
        approximate: true,
      },
    ];
  });

  const containerClass =
    activeView === 'map'
      ? 'mx-auto max-w-screen-2xl px-4 py-6'
      : 'mx-auto max-w-7xl px-4 py-8 sm:px-6';

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

      <header className="mb-6 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-sm">
        <div className="h-20 bg-gradient-to-r from-sky-100 via-indigo-100 to-violet-100" />
        <div className="px-5 pb-5 pt-4">
          <h1 className="text-2xl font-semibold tracking-tight">Known entities</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Analyst-curated rolodex — buyers, sellers, refiners, and trading houses VTC has researched
            as relevant to its deal flow. Includes entities with no public-tender activity (private
            refiners, trading houses) that the supplier-graph queries can&apos;t see.
          </p>
        </div>
      </header>

      {/* Smart-search bar — full-width across the page above the two-
          column body. Free-text NLP → server action parses to filters
          via Haiku → redirects with structured URL params. Falls back
          to plain ?q= if the LLM is unavailable. */}
      <form
        action={smartSearchAction}
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[color:var(--color-muted-foreground)]"
          >
            ✨
          </span>
          <input
            type="search"
            name="query"
            defaultValue={smartQuery ?? ''}
            placeholder='Smart search — e.g. "pork suppliers in the midwest", "approved Caribbean fuel buyers"'
            className="w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] py-2 pl-9 pr-3 text-sm outline-none placeholder:text-[color:var(--color-muted-foreground)] focus:border-[color:var(--color-foreground)]/50"
          />
        </div>
        <button
          type="submit"
          className="rounded-[var(--radius-md)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
        >
          Search
        </button>
      </form>

      {smartQuery && (
        <div className="mb-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-3 py-2 text-xs">
          <span className="text-[color:var(--color-muted-foreground)]">
            Interpreted{' '}
            <em className="not-italic text-[color:var(--color-foreground)]">
              &ldquo;{smartQuery}&rdquo;
            </em>{' '}
            as the filters in the left rail.{' '}
          </span>
          <Link
            href={baseHref({ smart: '' })}
            className="underline hover:no-underline"
          >
            Clear smart search
          </Link>
        </div>
      )}

      {/* Two-column body: left rail of filters + right column of
          results. On narrow screens the rail collapses above the
          results. The map view bypasses this — it owns the full
          width below. */}
      {activeView === 'map' ? (
        <>
          <div className="mb-4 flex items-center justify-between gap-4">
            <p className="text-sm text-[color:var(--color-muted-foreground)]">
              <span className="font-medium text-[color:var(--color-foreground)] tabular-nums">
                {rows.length.toLocaleString()}
                {truncated ? '+' : ''}
              </span>{' '}
              {rows.length === 1 ? 'entity' : 'entities'}
            </p>
            <div className="flex gap-1 text-xs">
              <Link
                href={baseHref({ view: 'list' })}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 hover:border-[color:var(--color-foreground)]"
              >
                List
              </Link>
              <Link
                href={baseHref({ view: 'map' })}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 px-3 py-1 hover:border-[color:var(--color-foreground)]"
              >
                Map
              </Link>
            </div>
          </div>
          <MapViewClient entities={mapEntities} totalCount={rows.length} />
        </>
      ) : (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        {/* ── Left rail: filters ─────────────────────────────────── */}
        <aside className="space-y-4 text-xs lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-2">
          <FilterSection title="Search name">
            <form
              action="/suppliers/known-entities"
              method="get"
              className="space-y-2"
            >
              {/* Preserve every other active filter on submit. */}
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
              {smart && <input type="hidden" name="smart" value={smart} />}
              <input
                type="search"
                name="q"
                defaultValue={nameQuery ?? ''}
                placeholder="Search name…"
                className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs outline-none placeholder:text-[color:var(--color-muted-foreground)] focus:border-[color:var(--color-foreground)]/50"
              />
            </form>
          </FilterSection>

          {activeFilters.length > 0 && (
            <FilterSection title="Active">
              <div className="flex flex-wrap gap-1">
                {activeFilters.map((f) => (
                  <Link
                    key={f.key}
                    href={f.clearHref}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 px-2 py-1 hover:bg-[color:var(--color-muted)]"
                    title={`Clear ${f.key}`}
                  >
                    <span>{f.label}</span>
                    <span
                      aria-hidden="true"
                      className="text-[color:var(--color-muted-foreground)]"
                    >
                      ×
                    </span>
                  </Link>
                ))}
                {activeFilters.length > 1 && (
                  <Link
                    href="/suppliers/known-entities"
                    className="px-1 py-1 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
                  >
                    clear all
                  </Link>
                )}
              </div>
            </FilterSection>
          )}

          <FilterSection title="Category">
            <div className="flex flex-wrap gap-1">
              {CATEGORY_OPTIONS.map((c) => (
                <FilterChip
                  key={c}
                  href={baseHref({ category: c })}
                  active={(category ?? 'all') === c}
                  label={c}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Role">
            <div className="flex flex-wrap gap-1">
              {ROLE_OPTIONS.map((r) => (
                <FilterChip
                  key={r.value}
                  href={baseHref({ role: r.value })}
                  active={(role ?? '') === r.value}
                  label={r.label}
                />
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Approval">
            <div className="flex flex-wrap gap-1">
              {APPROVAL_FILTERS.map((f) => (
                <FilterChip
                  key={f.value || 'all'}
                  href={baseHref({ approval: f.value })}
                  active={(approvalFilter ?? '') === f.value}
                  label={f.label}
                />
              ))}
            </div>
          </FilterSection>

          {regionTags.length > 0 && (
            <FilterSection title="Region">
              <div className="flex flex-wrap gap-1">
                {regionTags.map((rt) => (
                  <FilterChip
                    key={rt.tag}
                    href={baseHref({ tag: rt.tag })}
                    active={tag === rt.tag}
                    label={`${labelRegionTag(rt.tag)} · ${rt.count}`}
                    title={rt.tag}
                  />
                ))}
              </div>
            </FilterSection>
          )}

          <FilterSection title="Tags">
            <div className="flex flex-wrap gap-1">
              {TAG_QUICK_FILTERS.map((t) => (
                <FilterChip
                  key={t}
                  href={baseHref({ tag: t })}
                  active={tag === t}
                  label={t}
                />
              ))}
            </div>
          </FilterSection>

          {/* Crude-grade compatibility chip wall — collapsed by default
              to keep the rail tight. */}
          <FilterSection title="Crude grade compatibility">
            <details className="group">
              <summary className="cursor-pointer list-none text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                <span>Expand grades</span>
                <span
                  aria-hidden="true"
                  className="ml-1 inline-block transition-transform group-open:rotate-180"
                >
                  ▾
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {gradesByRegion.map(({ region, grades }) => (
                  <div key={`grade-${region}`}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      {region}
                    </div>
                    <div className="flex flex-wrap gap-1">
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
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </FilterSection>
        </aside>

        {/* ── Right column: results ─────────────────────────────── */}
        <div>
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
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40 px-3 py-1 hover:border-[color:var(--color-foreground)]"
              >
                List
              </Link>
              <Link
                href={baseHref({ view: 'map' })}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 hover:border-[color:var(--color-foreground)]"
              >
                Map
              </Link>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No entities match these filters. Try widening the category or clearing tags.
            </div>
          ) : (
            countries.map((c) => {
              const groupRows = byCountry.get(c)!;
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
                  <ul className="divide-y divide-[color:var(--color-border)] overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-sm">
                    {groupRows.map((e) => {
                      const rawNoteKv = parseNotes(e.notes);
                      const noteKv = rawNoteKv
                        ? collapseOwnership(rawNoteKv, e.country)
                        : null;
                      const isPlant = e.role === 'power-plant';
                      const { stats, remaining } =
                        isPlant && noteKv
                          ? extractPlantStats(noteKv)
                          : { stats: null, remaining: noteKv ?? [] };
                      const visibleTags = e.tags.filter(
                        (t) => !isNoiseTag(t),
                      );
                      const headlineParts: string[] = [];
                      if (e.role) headlineParts.push(e.role);
                      if (e.categories.length > 0)
                        headlineParts.push(e.categories.slice(0, 2).join(' · '));
                      const headline = headlineParts.join(' · ');
                      const aliasLine =
                        e.aliases.length > 1
                          ? e.aliases.filter((a) => a !== e.name).slice(0, 2).join(', ')
                          : null;
                      return (
                        <li
                          key={e.id}
                          className="group flex gap-4 px-4 py-4 transition-colors hover:bg-[color:var(--color-muted)]/20"
                        >
                          <div className="pt-0.5">
                            <EntityAvatar name={e.name} size="md" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <Link
                                href={`/entities/${encodeURIComponent(e.slug)}`}
                                className="text-base font-semibold tracking-tight hover:underline"
                              >
                                {e.name}
                              </Link>
                              {e.approvalStatus && (
                                <KycBadge
                                  status={e.approvalStatus}
                                  expiresAt={e.approvalExpiresAt}
                                />
                              )}
                              {e.apolloFundingStage && (
                                <span
                                  className="inline-block rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]"
                                  title={
                                    e.apolloLatestFundingAt
                                      ? `Latest funding: ${e.apolloLatestFundingAt} (Apollo)`
                                      : 'Apollo funding stage'
                                  }
                                >
                                  {e.apolloFundingStage}
                                </span>
                              )}
                            </div>
                            {headline && (
                              <p className="mt-0.5 text-sm text-[color:var(--color-muted-foreground)]">
                                {headline}
                              </p>
                            )}
                            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                              {formatCountry(e.country)}
                              {aliasLine && <> · aka {aliasLine}</>}
                            </p>
                            {stats && (
                              <p className="mt-2 text-sm tabular-nums">{stats}</p>
                            )}
                            {remaining.length > 0 && (
                              <dl
                                className={`${stats ? 'mt-1.5' : 'mt-2'} grid gap-x-4 gap-y-0.5 sm:grid-cols-2`}
                              >
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
                              <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                                Contact: {e.contactEntity}
                              </p>
                            )}
                            {visibleTags.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {visibleTags.slice(0, 6).map((t) => (
                                  <Link
                                    key={t}
                                    href={baseHref({ tag: t })}
                                    className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
                                  >
                                    {t}
                                  </Link>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="hidden shrink-0 items-start sm:flex">
                            <Link
                              href={`/entities/${encodeURIComponent(e.slug)}`}
                              className="rounded-full border border-[color:var(--color-foreground)]/70 px-3 py-1 text-xs font-medium text-[color:var(--color-foreground)] hover:bg-[color:var(--color-foreground)] hover:text-[color:var(--color-background)]"
                            >
                              View profile
                            </Link>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Curated by analyst research + augmented from Wikidata, GEM, Wikipedia, OSM, and FracTracker.
        Slate compatibility (<code>compatible:&lt;grade&gt;</code> tags) is analyst-curated. Not a
        substitute for customs / AIS data when current import flows matter.
      </footer>
    </div>
  );
}

function FilterSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title}
      </div>
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
