import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  listCompanyPursuits,
  STAGE_LABEL,
  STAGE_ORDER,
  type PursuitStageKey,
} from '../../../lib/capture-queries';
import { PursuitCard } from '../components/pursuit-card';

export const dynamic = 'force-dynamic';

function getOne(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isStage(v: string | undefined): v is PursuitStageKey {
  return STAGE_ORDER.includes(v as PursuitStageKey);
}

/**
 * Substring-match a pursuit against a query string. Case-insensitive,
 * whitespace-tolerant. Match across the fields a user is likely to
 * remember: opportunity title, agency, jurisdiction, reference number,
 * and pursuit notes.
 */
function pursuitMatches(p: Awaited<ReturnType<typeof listCompanyPursuits>>[number], q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    p.opportunity.title,
    p.opportunity.agencyName,
    p.opportunity.referenceNumber,
    p.opportunity.jurisdictionName,
    p.notes,
    p.assignedUserName,
  ]
    .filter(Boolean)
    .join('  ')
    .toLowerCase();
  return haystack.includes(needle);
}

export default async function PursuitsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const stageParam = getOne(sp.stage);
  const activeStage: PursuitStageKey | null = isStage(stageParam) ? stageParam : null;
  const q = (getOne(sp.q) ?? '').trim();

  const { company } = await requireCompany();
  const all = await listCompanyPursuits(company.id);
  const filtered = all.filter((p) => {
    if (activeStage && p.stage !== activeStage) return false;
    if (q && !pursuitMatches(p, q)) return false;
    return true;
  });

  // Build hrefs for the stage chips so the search query persists when
  // the user switches stages — otherwise the filter "resets" on click.
  const buildHref = (stage: PursuitStageKey | null): string => {
    const params = new URLSearchParams();
    if (stage) params.set('stage', stage);
    if (q) params.set('q', q);
    const qs = params.toString();
    return qs ? `/capture/pursuits?${qs}` : '/capture/pursuits';
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">All pursuits</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {filtered.length} of {all.length} total
            {q && (
              <>
                {' '}· matching <span className="font-medium">&ldquo;{q}&rdquo;</span>
              </>
            )}
          </p>
        </div>
        <a
          href="/api/pipeline/export.csv"
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
        >
          Download .csv
        </a>
      </header>

      {/* Search box — GET form so the query lives in the URL and is
          shareable / preserved across the stage chips. */}
      <form method="GET" className="mb-4 flex gap-2">
        {activeStage && <input type="hidden" name="stage" value={activeStage} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by title, agency, jurisdiction, reference, notes…"
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
            href={buildHref(activeStage)
              .replace(/[?&]q=[^&]*/, '')
              .replace(/\?$/, '')}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
          >
            Clear
          </Link>
        )}
      </form>

      <nav className="mb-6 flex flex-wrap gap-2 text-sm">
        <FilterLink href={buildHref(null)} active={!activeStage}>
          All
        </FilterLink>
        {STAGE_ORDER.map((s) => (
          <FilterLink key={s} href={buildHref(s)} active={activeStage === s}>
            {STAGE_LABEL[s]}
          </FilterLink>
        ))}
      </nav>

      {filtered.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="font-medium">
            {q
              ? 'No pursuits match your search'
              : activeStage
                ? 'No pursuits at this stage'
                : 'No pursuits yet'}
          </p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            {q ? (
              <>
                Try a shorter query, or{' '}
                <Link href={buildHref(activeStage).replace(/[?&]q=[^&]*/, '').replace(/\?$/, '')} className="underline">
                  clear the search
                </Link>
                .
              </>
            ) : (
              <>
                Track an opportunity from{' '}
                <a
                  className="underline"
                  href={process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}
                >
                  Discover
                </a>
                .
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PursuitCard key={p.id} card={p} />
          ))}
        </div>
      )}
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
