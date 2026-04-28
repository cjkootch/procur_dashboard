import Link from 'next/link';
import { lookupKnownEntities } from '@procur/catalog';

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
 *   ?role=refiner|trader|producer|state-buyer
 *   ?tag=region:mediterranean
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
];

const TAG_QUICK_FILTERS = [
  'region:mediterranean',
  'region:asia-state',
  'public-tender-visible',
  'libya-historic',
  'sweet-crude-runner',
  'top-tier',
];

interface Props {
  searchParams: Promise<{
    category?: string;
    country?: string;
    role?: string;
    tag?: string;
  }>;
}

export default async function KnownEntitiesPage({ searchParams }: Props) {
  const { category, country, role, tag } = await searchParams;
  const categoryTag = category && category !== 'all' ? category : undefined;

  const rows = await lookupKnownEntities({
    categoryTag,
    country: country?.trim() || undefined,
    role: role?.trim() || undefined,
    tag: tag?.trim() || undefined,
    limit: 200,
  });

  // Group by country for at-a-glance scanning.
  const byCountry = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byCountry.get(r.country) ?? [];
    list.push(r);
    byCountry.set(r.country, list);
  }
  const countries = [...byCountry.keys()].sort();

  const baseHref = (
    override: Partial<{ category: string; country: string; role: string; tag: string }>,
  ) => {
    const next = new URLSearchParams();
    const cat = override.category ?? category ?? 'all';
    if (cat) next.set('category', cat);
    const c = override.country ?? country;
    if (c) next.set('country', c);
    const r = override.role ?? role;
    if (r) next.set('role', r);
    const t = override.tag ?? tag;
    if (t) next.set('tag', t);
    return `/suppliers/known-entities?${next.toString()}`;
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
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

      <section className="mb-6 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[color:var(--color-muted-foreground)]">Category:</span>
          {CATEGORY_OPTIONS.map((c) => (
            <Link
              key={c}
              href={baseHref({ category: c })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                (category ?? 'all') === c
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {c}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[color:var(--color-muted-foreground)]">Role:</span>
          {ROLE_OPTIONS.map((r) => (
            <Link
              key={r.value}
              href={baseHref({ role: r.value })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                (role ?? '') === r.value
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[color:var(--color-muted-foreground)]">Tags:</span>
          {TAG_QUICK_FILTERS.map((t) => (
            <Link
              key={t}
              href={baseHref({ tag: t })}
              className={`rounded-[var(--radius-sm)] border px-2 py-1 hover:border-[color:var(--color-foreground)] ${
                tag === t
                  ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
                  : 'border-[color:var(--color-border)]'
              }`}
            >
              {t}
            </Link>
          ))}
          {tag && (
            <Link
              href={baseHref({ tag: '' })}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:border-[color:var(--color-foreground)]"
            >
              clear tag
            </Link>
          )}
        </div>
      </section>

      <p className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        {rows.length} entit{rows.length === 1 ? 'y' : 'ies'} matched
        {category && category !== 'all' ? ` in ${category}` : ''}
        {country ? ` (${country})` : ''}
        {role ? `, ${role}` : ''}
        {tag ? `, tagged ${tag}` : ''}.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
          No entities match these filters. Try widening the category or clearing tags.
        </div>
      ) : (
        countries.map((c) => (
          <section key={c} className="mb-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              {c}
              <span className="ml-2 font-normal text-[color:var(--color-muted-foreground)]">
                ({byCountry.get(c)!.length})
              </span>
            </h2>
            <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30">
                  <tr>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Name
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Role
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Notes
                    </th>
                    <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                      Tags
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byCountry.get(c)!.map((e) => (
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
                        {e.aliases.length > 1 && (
                          <div className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                            aka {e.aliases.filter((a) => a !== e.name).slice(0, 2).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-[color:var(--color-muted-foreground)]">
                        {e.role}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="text-sm">{e.notes ?? '—'}</div>
                        {e.contactEntity && (
                          <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                            Contact: {e.contactEntity}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex flex-wrap gap-1">
                          {e.tags.slice(0, 4).map((t) => (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Curated by analyst research + augmented from Wikidata via{' '}
        <code>pnpm --filter @procur/db ingest-wikidata-refineries</code>. Not a substitute for
        customs/AIS data when current import flows matter. The notes field captures editorial; treat
        it as a starting point.
      </footer>
    </div>
  );
}
