import Link from 'next/link';
import type { Metadata } from 'next';
import { listJurisdictions } from '../../lib/queries';
import { flagFor } from '../../lib/flags';

export const revalidate = 600;

export const metadata: Metadata = {
  title: 'Jurisdictions',
  description:
    'All government procurement jurisdictions covered by Procur Discover: Caribbean, Latin America, Africa, and multilateral development banks.',
};

const REGION_LABEL: Record<string, string> = {
  caribbean: 'Caribbean',
  latam: 'Latin America',
  africa: 'Africa',
  global: 'Global / Multilateral',
};

export default async function JurisdictionsPage() {
  const all = await listJurisdictions();

  const grouped = new Map<string, typeof all>();
  for (const j of all) {
    const list = grouped.get(j.region) ?? [];
    list.push(j);
    grouped.set(j.region, list);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Jurisdictions</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {all.filter((j) => j.active).length} active ·{' '}
          {all.filter((j) => !j.active).length} coming soon
        </p>
      </header>

      {Array.from(grouped.entries()).map(([region, items]) => (
        <section key={region} className="mb-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {REGION_LABEL[region] ?? region}
          </h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {items.map((j) => (
              <Link
                key={j.slug}
                href={`/jurisdictions/${j.slug}`}
                className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
              >
                <span
                  aria-label={j.name}
                  className="text-2xl leading-none"
                >
                  {flagFor(j.countryCode)}
                </span>
                <div className="flex-1">
                  <p className="font-medium">{j.name}</p>
                  <p className="text-xs text-[color:var(--color-muted-foreground)]">
                    {j.active
                      ? `${(j.opportunitiesCount ?? 0).toLocaleString()} active`
                      : 'Coming soon'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
