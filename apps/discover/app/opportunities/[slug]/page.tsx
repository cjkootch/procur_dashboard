import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getOpportunityBySlug, getOpportunityDocuments } from '../../../lib/queries';
import { flagFor } from '../../../lib/flags';
import {
  formatDate,
  formatMoney,
  pickTranslated,
  preferredLanguage,
  timeUntil,
} from '../../../lib/format';

// SSR every request — never serve stale content; we own the freshness.
export const dynamic = 'force-dynamic';

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
  const hdrs = await headers();
  const userLanguage = preferredLanguage(hdrs.get('accept-language'));
  const displayTitle =
    pickTranslated('title', op.title, op.language, op.translations, userLanguage) ?? op.title;
  const displaySummary = pickTranslated('summary', op.aiSummary, op.language, op.translations, userLanguage);
  const displayDescription = pickTranslated(
    'description',
    op.description,
    op.language,
    op.translations,
    userLanguage,
  );

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
        <h1 className="text-3xl font-semibold tracking-tight">{displayTitle}</h1>
        {op.referenceNumber && (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            Reference: {op.referenceNumber}
          </p>
        )}
      </header>

      {(op.tags?.length || op.subCategory) && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {op.subCategory && (
            <span className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)] px-2 py-0.5 text-xs text-[color:var(--color-foreground)]">
              {op.subCategory}
            </span>
          )}
          {op.tags?.map((t) => (
            <span
              key={t}
              className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)] px-2 py-0.5 text-xs text-[color:var(--color-foreground)]"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <section className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact label="Estimated value" value={value ?? '—'} sub={valueUsd ? `≈ ${valueUsd}` : undefined} />
        <Fact
          label="Closing"
          value={op.deadlineAt ? formatDate(op.deadlineAt) : '—'}
          sub={countdown && countdown !== 'closed' ? `in ${countdown}` : undefined}
          highlight={countdown && countdown !== 'closed' ? 'brand' : undefined}
        />
        {/* Posted date — falls back to firstSeenAt (when Procur first
            scraped the listing) when the source portal didn't expose
            publishedAt. Many gov procurement portals list tenders
            without a posted-on stamp; this keeps the column from
            being permanently "—" for those. */}
        <Fact
          label={op.publishedAt ? 'Published' : 'Discovered'}
          value={
            op.publishedAt
              ? formatDate(op.publishedAt)
              : op.firstSeenAt
                ? formatDate(op.firstSeenAt)
                : '—'
          }
          sub={op.publishedAt ? undefined : 'first seen on this date'}
        />
        <Fact label="Category" value={op.category ?? '—'} />
      </section>

      {(op.preBidMeetingAt || op.clarificationDeadlineAt) && (
        <section className="mt-4 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-2">
          <Fact
            label="Pre-bid meeting"
            value={op.preBidMeetingAt ? formatDate(op.preBidMeetingAt) : '—'}
          />
          <Fact
            label="Clarification deadline"
            value={
              op.clarificationDeadlineAt ? formatDate(op.clarificationDeadlineAt) : '—'
            }
          />
        </section>
      )}

      {op.status === 'awarded' && (
        <section className="mt-4 rounded-[var(--radius-lg)] border border-emerald-500/30 bg-emerald-500/5 p-6">
          <p className="text-xs uppercase tracking-wide text-emerald-700">Awarded</p>
          <div className="mt-2 grid gap-4 md:grid-cols-3">
            <Fact
              label="Awarded to"
              value={op.awardedToCompanyName ?? '—'}
            />
            <Fact
              label="Awarded value"
              value={
                formatMoney(op.awardedAmount, op.currency) ?? '—'
              }
            />
            <Fact
              label="Award date"
              value={op.awardedAt ? formatDate(op.awardedAt) : '—'}
            />
          </div>
        </section>
      )}

      {displaySummary && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Summary</h2>
          <p className="mt-2 text-base leading-relaxed">{displaySummary}</p>
        </section>
      )}

      {displayDescription && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Description</h2>
          <p className="mt-2 whitespace-pre-line text-base leading-relaxed text-[color:var(--color-muted-foreground)]">
            {displayDescription}
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

      <section className="mt-8 flex flex-wrap gap-3">
        <a
          href={`${appUrl}/capture/new?opportunity=${op.id}`}
          className="inline-flex items-center rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
        >
          Track this opportunity →
        </a>
        {op.sourceUrl && (
          <a
            href={op.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-4 py-2 text-sm font-medium hover:border-[color:var(--color-foreground)]"
          >
            View on source portal ↗
          </a>
        )}
      </section>

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
