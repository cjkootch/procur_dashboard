import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { listAtlasFacts } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ country: string }>;
}

/**
 * Per-country market atlas. Shows all current (non-superseded) facts
 * grouped by fact_type. Read-only here — operators add facts via the
 * probe detail page (where each fact gets stamped with source_probe_id
 * for provenance).
 */
export default async function MarketAtlasCountryPage({ params }: PageProps) {
  await requireCompany();
  const { country: rawCountry } = await params;
  const country = rawCountry.toUpperCase();
  if (!/^[A-Z]{2}$|^XX$/.test(country)) notFound();

  const facts = await listAtlasFacts({ country });
  if (facts.length === 0) notFound();

  // Group by fact_type so the page reads as a structured atlas, not
  // a chronological dump.
  const byType: Record<string, typeof facts> = {};
  for (const f of facts) {
    byType[f.factType] ??= [];
    byType[f.factType]!.push(f);
  }
  const orderedTypes = Object.keys(byType).sort();

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <Link
        href="/market-atlas"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Market Atlas
      </Link>
      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight font-mono">
          {country}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {facts.length} fact{facts.length === 1 ? '' : 's'} across{' '}
          {orderedTypes.length} categor
          {orderedTypes.length === 1 ? 'y' : 'ies'}.
        </p>
      </header>

      <div className="space-y-6">
        {orderedTypes.map((type) => (
          <section key={type}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              {type} ({byType[type]!.length})
            </h2>
            <ul className="space-y-2">
              {byType[type]!.map((f) => (
                <li
                  key={f.id}
                  className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-sm"
                >
                  <div className="flex items-baseline gap-2">
                    {f.entitySlug && (
                      <Link
                        href={`/entities/${encodeURIComponent(f.entitySlug)}`}
                        className="font-medium hover:underline"
                      >
                        {f.entitySlug}
                      </Link>
                    )}
                    {f.relatedEntitySlug && (
                      <>
                        <span className="text-[color:var(--color-muted-foreground)]">
                          ↔
                        </span>
                        <Link
                          href={`/entities/${encodeURIComponent(f.relatedEntitySlug)}`}
                          className="font-medium hover:underline"
                        >
                          {f.relatedEntitySlug}
                        </Link>
                      </>
                    )}
                    {f.segment && (
                      <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px]">
                        {f.segment}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-[color:var(--color-muted-foreground)]">
                      {f.authoredBy} · {Math.round(Number(f.confidence) * 100)}%
                    </span>
                  </div>
                  <p className="mt-1.5">{f.description}</p>
                  {f.sourceProbeId && (
                    <Link
                      href={`/market-probes/${f.sourceProbeId}`}
                      className="mt-1 inline-block text-[10px] text-[color:var(--color-muted-foreground)] hover:underline"
                    >
                      from probe {f.sourceProbeId}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
