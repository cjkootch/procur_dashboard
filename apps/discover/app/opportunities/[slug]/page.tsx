import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOpportunityBySlug, getOpportunityDocuments } from '../../../lib/queries';
import { flagFor } from '../../../lib/flags';
import { formatDate, formatMoney, timeUntil } from '../../../lib/format';

export const revalidate = 600;

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const op = await getOpportunityBySlug(slug);
  if (!op) return { title: 'Not found' };

  const title = `${op.title} | ${op.agencyShort ?? op.agencyName ?? op.jurisdictionName}`;
  const description = op.aiSummary ?? op.description?.slice(0, 160) ?? undefined;
  return {
    title,
    description,
    openGraph: { title, description, type: 'article' },
    alternates: { canonical: `/opportunities/${slug}` },
  };
}

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const op = await getOpportunityBySlug(slug);
  if (!op) notFound();

  const docs = await getOpportunityDocuments(op.id);
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const countdown = timeUntil(op.deadlineAt);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Offer',
    name: op.title,
    url: `${process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}/opportunities/${op.slug}`,
    description: op.aiSummary ?? op.description ?? '',
    priceCurrency: op.currency ?? 'USD',
    validThrough: op.deadlineAt?.toISOString(),
    seller: {
      '@type': 'GovernmentOrganization',
      name: op.agencyName ?? op.jurisdictionName,
    },
    areaServed: {
      '@type': 'Country',
      name: op.jurisdictionName,
    },
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/opportunities" className="hover:underline">
          Opportunities
        </Link>
        <span> / </span>
        <Link
          href={`/jurisdictions/${op.jurisdictionSlug}`}
          className="hover:underline"
        >
          {op.jurisdictionName}
        </Link>
      </nav>

      <header className="mb-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span
            title={op.jurisdictionName}
            aria-label={op.jurisdictionName}
            className="text-xl leading-none"
          >
            {flagFor(op.jurisdictionCountry)}
          </span>
          <span className="text-[color:var(--color-muted-foreground)]">
            {op.jurisdictionName}
            {op.agencyName && <> · {op.agencyName}</>}
          </span>
          {op.type && (
            <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
              {op.type}
            </span>
          )}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{op.title}</h1>
        {op.referenceNumber && (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            Reference: {op.referenceNumber}
          </p>
        )}
      </header>

      <section className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact label="Estimated value" value={value ?? '—'} sub={valueUsd ? `≈ ${valueUsd}` : undefined} />
        <Fact
          label="Closing"
          value={op.deadlineAt ? formatDate(op.deadlineAt) : '—'}
          sub={countdown && countdown !== 'closed' ? `in ${countdown}` : undefined}
          highlight={countdown && countdown !== 'closed' ? 'brand' : undefined}
        />
        <Fact label="Published" value={op.publishedAt ? formatDate(op.publishedAt) : '—'} />
        <Fact label="Category" value={op.category ?? '—'} />
      </section>

      {op.aiSummary && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Summary</h2>
          <p className="mt-2 text-base leading-relaxed">{op.aiSummary}</p>
        </section>
      )}

      {op.description && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Description</h2>
          <p className="mt-2 whitespace-pre-line text-base leading-relaxed text-[color:var(--color-muted-foreground)]">
            {op.description}
          </p>
        </section>
      )}

      {docs.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Documents</h2>
          <ul className="mt-2 space-y-2">
            {docs.map((d) => (
              <li key={d.id}>
                <a
                  href={d.originalUrl}
                  className="text-sm underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {d.title ?? d.documentType}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-6">
        <p className="text-sm font-medium">Want the full picture?</p>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Procur Pro unlocks compliance matrix, requirements analysis, AI-drafted proposal
          outline, team collaboration, and Word export for this tender.
        </p>
        <a
          href={appUrl}
          className="mt-4 inline-flex items-center rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
        >
          Try Procur Pro →
        </a>
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[color:var(--color-muted-foreground)]">Share:</span>
        <a
          className="underline"
          target="_blank"
          rel="noopener noreferrer"
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
            `${process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}/opportunities/${op.slug}`,
          )}`}
        >
          LinkedIn
        </a>
        <a
          className="underline"
          href={`mailto:?subject=${encodeURIComponent(op.title)}&body=${encodeURIComponent(
            `${process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app'}/opportunities/${op.slug}`,
          )}`}
        >
          Email
        </a>
      </section>
    </div>
  );
}

function Fact({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: 'brand';
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p
        className={`mt-1 text-base font-semibold ${
          highlight === 'brand' ? 'text-[color:var(--color-brand)]' : ''
        }`}
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
