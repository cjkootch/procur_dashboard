import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import {
  LIBRARY_TYPES,
  LIBRARY_TYPE_LABEL,
  listLibrary,
  type LibraryType,
} from '../../lib/library-queries';

export const dynamic = 'force-dynamic';

type SearchParams = {
  q?: string;
  type?: string;
};

function isLibraryType(v: string | undefined): v is LibraryType {
  return Boolean(v) && (LIBRARY_TYPES as readonly string[]).includes(v as string);
}

export default async function LibraryListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const typeFilter: LibraryType | null = isLibraryType(sp.type) ? sp.type : null;

  const { company } = await requireCompany();
  const all = await listLibrary(company.id);

  // Substring + tag match on title, content, tags. Case-insensitive.
  const needle = q.toLowerCase();
  const entries = all.filter((e) => {
    if (typeFilter && e.type !== typeFilter) return false;
    if (needle.length === 0) return true;
    const haystack = [
      e.title,
      e.content,
      ...(e.tags ?? []),
    ]
      .filter(Boolean)
      .join('  ')
      .toLowerCase();
    return haystack.includes(needle);
  });

  // Type-filter chips persist q; q-clear preserves type — same pattern as
  // /capture/pursuits, so users don't lose state navigating the toolbar.
  const buildHref = (nextType: LibraryType | null): string => {
    const params = new URLSearchParams();
    if (nextType) params.set('type', nextType);
    if (q) params.set('q', q);
    const qs = params.toString();
    return qs ? `/library?${qs}` : '/library';
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Content library</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Reusable content the AI drafter pulls from when writing proposal sections.
            {(q || typeFilter) && (
              <>
                {' '}· {entries.length} of {all.length}
              </>
            )}
          </p>
        </div>
        <Link
          href="/library/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          + Add entry
        </Link>
      </header>

      {all.length > 0 && (
        <>
          <form method="GET" className="mb-3 flex gap-2">
            {typeFilter && <input type="hidden" name="type" value={typeFilter} />}
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search by title, content, or tag…"
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
                href={buildHref(typeFilter).replace(/[?&]q=[^&]*/, '').replace(/\?$/, '')}
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
              >
                Clear
              </Link>
            )}
          </form>

          <nav className="mb-5 flex flex-wrap gap-2 text-xs">
            <FilterLink href={buildHref(null)} active={!typeFilter}>
              All types
            </FilterLink>
            {LIBRARY_TYPES.map((t) => (
              <FilterLink key={t} href={buildHref(t)} active={typeFilter === t}>
                {LIBRARY_TYPE_LABEL[t]}
              </FilterLink>
            ))}
          </nav>
        </>
      )}

      {entries.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          {all.length === 0 ? (
            <>
              <p className="font-medium">Nothing in your library yet</p>
              <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                Start by adding a capability statement, a couple of past performance entries, and
                some team bios. The AI drafter retrieves the top 5 most-relevant entries for each
                proposal section.
              </p>
              <Link
                href="/library/new"
                className="mt-4 inline-block text-sm underline"
              >
                Add your first entry →
              </Link>
            </>
          ) : (
            <>
              <p className="font-medium">No entries match these filters</p>
              <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
                Try a shorter query, switch the type, or{' '}
                <Link href="/library" className="underline">
                  clear all filters
                </Link>
                .
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Link
              key={e.id}
              href={`/library/${e.id}`}
              className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{e.title}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {LIBRARY_TYPE_LABEL[e.type as keyof typeof LIBRARY_TYPE_LABEL] ?? e.type}
                    {e.tags && e.tags.length > 0 && <> · {e.tags.join(', ')}</>}
                  </p>
                </div>
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {e.embedding ? 'Embedded' : 'Not indexed'}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-[color:var(--color-muted-foreground)]">
                {e.content}
              </p>
            </Link>
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
