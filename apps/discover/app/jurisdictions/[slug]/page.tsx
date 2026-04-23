import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAgenciesForJurisdiction,
  getJurisdictionBySlug,
  listOpportunities,
} from '../../../lib/queries';
import { OpportunityCard } from '../../../components/opportunity-card';
import { flagFor } from '../../../lib/flags';

export const revalidate = 600;

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const j = await getJurisdictionBySlug(slug);
  if (!j) return { title: 'Not found' };
  return {
    title: `${j.name} government tenders`,
    description: `Active procurement opportunities from ${j.name}, sourced from ${j.portalName ?? 'the national portal'}.`,
    alternates: { canonical: `/jurisdictions/${slug}` },
  };
}

export default async function JurisdictionDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const jur = await getJurisdictionBySlug(slug);
  if (!jur) notFound();

  const [{ rows, total }, agencies] = await Promise.all([
    listOpportunities({ jurisdiction: slug, perPage: 24, sort: 'deadline-asc' }),
    getAgenciesForJurisdiction(jur.id),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-start gap-4">
        <span aria-label={jur.name} className="text-4xl leading-none">
          {flagFor(jur.countryCode)}
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{jur.name}</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            {total.toLocaleString()} active opportunities
            {jur.currency && <> · Currency: {jur.currency}</>}
          </p>
          {jur.portalUrl && (
            <p className="mt-1 text-sm">
              Source:{' '}
              <a
                className="underline"
                href={jur.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {jur.portalName ?? jur.portalUrl}
              </a>
            </p>
          )}
        </div>
      </header>

      {agencies.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Active procuring agencies
          </h2>
          <div className="flex flex-wrap gap-2">
            {agencies.slice(0, 20).map((a) => (
              <span
                key={a.id}
                className="rounded-full border border-[color:var(--color-border)] px-3 py-1 text-xs"
              >
                {a.shortName ?? a.name}
                {a.opportunitiesCount ? (
                  <span className="ml-1 text-[color:var(--color-muted-foreground)]">
                    · {a.opportunitiesCount}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Active opportunities</h2>
          <Link
            className="text-sm underline"
            href={`/opportunities?jurisdiction=${slug}`}
          >
            Browse all →
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No active tenders right now. Check back — scrapers refresh every few hours.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rows.map((op) => (
              <OpportunityCard key={op.id} op={op} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
