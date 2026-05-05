import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  DEAL_CATEGORIES,
  VTC_ENTITIES,
  lookupDealStructureTemplates,
  lookupCommissionStructures,
  type DealCategory,
  type VtcEntity,
} from '@procur/catalog';
import type { CommissionStructure, DealStructureTemplate } from '@procur/db';

export const dynamic = 'force-dynamic';

type View = 'templates' | 'commissions';

type SearchParams = {
  view?: string;
  q?: string;
  category?: string;
  entity?: string;
};

function isView(v: string | undefined): v is View {
  return v === 'templates' || v === 'commissions';
}
function isCategory(v: string | undefined): v is DealCategory {
  return Boolean(v) && (DEAL_CATEGORIES as readonly string[]).includes(v as string);
}
function isEntity(v: string | undefined): v is VtcEntity {
  return Boolean(v) && (VTC_ENTITIES as readonly string[]).includes(v as string);
}

const CATEGORY_LABEL: Record<DealCategory, string> = {
  'refined-product': 'Refined product',
  'specialty-crude': 'Specialty crude',
  'crude-conventional': 'Crude (conventional)',
  'food-commodity': 'Food commodity',
  vehicle: 'Vehicle',
  lng: 'LNG',
  lpg: 'LPG',
};

const ENTITY_LABEL: Record<VtcEntity, string> = {
  'vtc-llc': 'VTC LLC',
  'vector-antilles': 'Vector Antilles',
  'vector-auto-exports': 'Vector Auto Exports',
  'vector-food-fund': 'Vector Food Fund',
  'stabroek-advisory': 'Stabroek Advisory',
};

export default async function DealStructuresBrowsePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const view: View = isView(sp.view) ? sp.view : 'templates';
  const q = (sp.q ?? '').trim();
  const category: DealCategory | null = isCategory(sp.category) ? sp.category : null;
  const entity: VtcEntity | null = isEntity(sp.entity) ? sp.entity : null;

  await requireCompany();

  if (view === 'commissions') {
    return (
      <CommissionsView q={q} entity={entity} />
    );
  }

  return <TemplatesView q={q} category={category} entity={entity} />;
}

async function TemplatesView({
  q,
  category,
  entity,
}: {
  q: string;
  category: DealCategory | null;
  entity: VtcEntity | null;
}) {
  const all = await lookupDealStructureTemplates({
    status: 'all',
    limit: 500,
    ...(entity ? { vtcEntity: entity } : {}),
  });

  const needle = q.toLowerCase();
  const rows = all.filter((t) => {
    if (category && t.category !== category) return false;
    if (needle.length === 0) return true;
    return [t.name, t.slug, t.notes ?? '', t.incoterm, t.paymentInstrument]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  const buildHref = (overrides: Partial<SearchParams>) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (category) params.set('category', category);
    if (entity) params.set('entity', entity);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/deal-structures?${qs}` : '/deal-structures';
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <ViewToggle view="templates" q={q} />

      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        VTC&apos;s standard deal-shaping templates &mdash; Incoterm &times; payment instrument
        &times; region &times; entity bundles. Proposals and contracts reference these
        templates by slug. Read-only catalog view; the assistant resolves the right template
        via{' '}
        <code className="text-[color:var(--color-foreground)]">compose_proposal_skeleton</code>.
        {(q || category || entity) && (
          <>
            {' '}&middot; {rows.length} of {all.length}
          </>
        )}
      </p>

      <form method="GET" className="mb-3 flex gap-2">
        <input type="hidden" name="view" value="templates" />
        {category && <input type="hidden" name="category" value={category} />}
        {entity && <input type="hidden" name="entity" value={entity} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, slug, Incoterm, payment instrument…"
          className="flex-1 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1.5 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Search
        </button>
        {q && (
          <Link
            href={buildHref({ q: '' })}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
          >
            Clear
          </Link>
        )}
      </form>

      <nav className="mb-2 flex flex-wrap gap-2 text-xs">
        <FilterLink href={buildHref({ category: '' })} active={!category}>
          All categories
        </FilterLink>
        {DEAL_CATEGORIES.map((c) => (
          <FilterLink key={c} href={buildHref({ category: c })} active={category === c}>
            {CATEGORY_LABEL[c]}
          </FilterLink>
        ))}
      </nav>

      <nav className="mb-5 flex flex-wrap gap-2 text-xs">
        <FilterLink href={buildHref({ entity: '' })} active={!entity}>
          All entities
        </FilterLink>
        {VTC_ENTITIES.map((e) => (
          <FilterLink key={e} href={buildHref({ entity: e })} active={entity === e}>
            {ENTITY_LABEL[e]}
          </FilterLink>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState totalCount={all.length} />
      ) : (
        <div className="space-y-2">
          {rows.map((t) => (
            <TemplateRow key={t.slug} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}

async function CommissionsView({
  q,
  entity,
}: {
  q: string;
  entity: VtcEntity | null;
}) {
  const all = await lookupCommissionStructures({
    status: 'all',
    limit: 500,
    ...(entity ? { vtcEntity: entity } : {}),
  });

  const needle = q.toLowerCase();
  const rows = all.filter((c) => {
    if (needle.length === 0) return true;
    return [c.name, c.slug, c.notes ?? '', c.basisType, c.partyRelationship]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  const buildHref = (overrides: Partial<SearchParams>) => {
    const params = new URLSearchParams();
    params.set('view', 'commissions');
    if (q) params.set('q', q);
    if (entity) params.set('entity', entity);
    for (const [k, v] of Object.entries(overrides)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    return `/deal-structures?${params.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <ViewToggle view="commissions" q={q} />

      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        Broker / origination partner / sub-broker fee arrangements VTC uses. Contracts
        reference these structures by slug at signature time; specific deals may deviate
        when negotiation alters the fee structure.
        {(q || entity) && (
          <>
            {' '}&middot; {rows.length} of {all.length}
          </>
        )}
      </p>

      <form method="GET" className="mb-3 flex gap-2">
        <input type="hidden" name="view" value="commissions" />
        {entity && <input type="hidden" name="entity" value={entity} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by name, slug, basis type…"
          className="flex-1 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1.5 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Search
        </button>
        {q && (
          <Link
            href={buildHref({ q: '' })}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
          >
            Clear
          </Link>
        )}
      </form>

      <nav className="mb-5 flex flex-wrap gap-2 text-xs">
        <FilterLink href={buildHref({ entity: '' })} active={!entity}>
          All entities
        </FilterLink>
        {VTC_ENTITIES.map((e) => (
          <FilterLink key={e} href={buildHref({ entity: e })} active={entity === e}>
            {ENTITY_LABEL[e]}
          </FilterLink>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState totalCount={all.length} />
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <CommissionRow key={c.slug} commission={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle({ view, q }: { view: View; q: string }) {
  const baseHref = (target: View) => {
    const params = new URLSearchParams();
    if (target === 'commissions') params.set('view', 'commissions');
    if (q) params.set('q', q);
    const qs = params.toString();
    return qs ? `/deal-structures?${qs}` : '/deal-structures';
  };
  return (
    <nav className="mb-4 flex gap-1 border-b border-[color:var(--color-border)]">
      <Link
        href={baseHref('templates')}
        className={`px-3 py-2 text-sm font-medium ${
          view === 'templates'
            ? 'border-b-2 border-[color:var(--color-foreground)] text-[color:var(--color-foreground)]'
            : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
        }`}
      >
        Templates
      </Link>
      <Link
        href={baseHref('commissions')}
        className={`px-3 py-2 text-sm font-medium ${
          view === 'commissions'
            ? 'border-b-2 border-[color:var(--color-foreground)] text-[color:var(--color-foreground)]'
            : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
        }`}
      >
        Commissions
      </Link>
    </nav>
  );
}

function TemplateRow({ template: t }: { template: DealStructureTemplate }) {
  const margin = formatMargin(t.typicalMarginMin, t.typicalMarginMax, t.marginUnit);
  return (
    <Link
      href={`/deal-structures/${t.slug}`}
      className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{t.name}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-[color:var(--color-muted-foreground)]">
            {t.slug}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {t.validatedByCounsel && <CounselBadge />}
          {t.status !== 'active' && <StatusPill status={t.status} />}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[color:var(--color-muted-foreground)] md:grid-cols-4">
        <Field label="Category" value={CATEGORY_LABEL[t.category as DealCategory] ?? t.category} />
        <Field label="Entity" value={ENTITY_LABEL[t.vtcEntity as VtcEntity] ?? t.vtcEntity} />
        <Field label="Incoterm" value={t.incoterm.toUpperCase()} />
        <Field label="Payment" value={t.paymentInstrument} />
        {margin && <Field label="Margin" value={margin} />}
        {t.applicableRegions.length > 0 && (
          <Field label="Regions" value={t.applicableRegions.join(', ')} />
        )}
      </div>
    </Link>
  );
}

function CommissionRow({ commission: c }: { commission: CommissionStructure }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{c.name}</p>
          <p className="mt-0.5 truncate font-mono text-xs text-[color:var(--color-muted-foreground)]">
            {c.slug}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {c.exclusivePerDeal && (
            <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
              Exclusive
            </span>
          )}
          {c.status !== 'active' && <StatusPill status={c.status} />}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[color:var(--color-muted-foreground)] md:grid-cols-4">
        <Field label="Category" value={c.category} />
        <Field label="Relationship" value={c.partyRelationship} />
        <Field label="Entity" value={ENTITY_LABEL[c.vtcEntity as VtcEntity] ?? c.vtcEntity} />
        <Field label="Basis" value={c.basisType} />
        <Field label="Trigger" value={c.triggerEvent} />
        <Field label="Timing" value={c.paymentTiming} />
      </div>
      <pre className="mt-3 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-2 text-[11px]">
        {JSON.stringify(c.feeStructure ?? {}, null, 2)}
      </pre>
    </div>
  );
}

function EmptyState({ totalCount }: { totalCount: number }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
      <p className="font-medium">
        {totalCount === 0 ? 'No catalog entries yet' : 'No entries match these filters'}
      </p>
      <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
        {totalCount === 0 ? (
          <>The deal-structures catalog is seeded via migration. Check the database.</>
        ) : (
          <>
            Try a shorter query or{' '}
            <Link href="/deal-structures" className="underline">
              clear all filters
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

function CounselBadge() {
  return (
    <span
      className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
      title="Validated by counsel"
    >
      Counsel-validated
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
      {status}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <p className="truncate text-[color:var(--color-foreground)]">{value}</p>
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
      className={`rounded-full border px-3 py-1 ${
        active
          ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
          : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
      }`}
    >
      {children}
    </Link>
  );
}

function formatMargin(
  min: string | null,
  max: string | null,
  unit: string | null,
): string | null {
  if (min == null && max == null) return null;
  const u = unit ?? '';
  const fmt = (v: string) => {
    if (u === 'pct') {
      const n = Number(v);
      return Number.isFinite(n) ? `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%` : v;
    }
    return v;
  };
  if (min != null && max != null) {
    if (u === 'pct') return `${fmt(min)}–${fmt(max)}`;
    return `${fmt(min)}–${fmt(max)} ${u.replace(/^usd-per-/, '$/')}`.trim();
  }
  const v = (min ?? max) as string;
  return u === 'pct' ? fmt(v) : `${fmt(v)} ${u.replace(/^usd-per-/, '$/')}`.trim();
}
