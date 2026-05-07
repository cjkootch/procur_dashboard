import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { requireCompany } from '@procur/auth';
import {
  getCurrentDisposition,
  getEntityProfile,
  getSupplierApproval,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';
import { EntityAvatar } from '../../../components/EntityAvatar';
import { KycBadge } from '../../../components/KycBadge';
import { parseEntityNotes } from '../../../lib/entity-notes';
import { QualifyAsLeadButton } from './_components/QualifyAsLeadButton';
import { EntityDocumentsPanel } from './_components/EntityDocumentsPanel';
import { QuoteAnchorsPanel } from './_components/QuoteAnchorsPanel';
import { SupplierApprovalForm } from './_components/SupplierApprovalForm';
import { EditableAttribute } from './_components/EditableAttribute';
import { DispositionPanel } from './_components/DispositionPanel';
import {
  ApolloCorporateSection,
  ContactsSection,
  ImportContextSection,
  OwnershipSection,
  SectionSkeleton,
  VesselActivitySection,
  WebsiteIntelligenceSection,
} from './_components/AsyncSections';

/**
 * Unified entity profile — accepts either a known_entities.slug or
 * an external_suppliers.id (UUID) and renders whatever's available
 * across both tables plus public-tender award history.
 *
 * Reached via:
 *   - profileUrl returned by lookup_known_entities, analyze_supplier,
 *     find_competing_sellers, find_buyers_for_offer chat tools
 *   - clicking a row in /suppliers/known-entities
 *   - direct URL (shareable for outreach context)
 *
 * Server component. Auth via apps/app/middleware.ts.
 */
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function EntityProfilePage({ params }: Props) {
  const { slug } = await params;
  const profile = await getEntityProfile(decodeURIComponent(slug));

  if (profile.primarySource === 'not_found') {
    notFound();
  }

  // Only await the data the header + above-the-fold approval form
  // strictly need. Everything below the fold (vessel activity, Apollo,
  // ownership, website intel, contacts, import-context) streams in via
  // Suspense — the long pole on this page is `getEntityVesselActivity`
  // (heavy CTE over `vessel_positions`) and the Web/Apollo lookups,
  // and there's no reason to gate the header on them.
  const { company } = await requireCompany();
  const user = await getCurrentUser();
  const [approval, currentDisposition] = await Promise.all([
    getSupplierApproval(company.id, profile.canonicalKey),
    user ? getCurrentDisposition(profile.canonicalKey, user.id) : Promise.resolve(null),
  ]);

  const cap = profile.capabilities;
  // Walk the ownership chain via the operator name when present
  // (refineries store operator in metadata.operator and that's the
  // one whose parents matter for sovereign-backing analysis); fall
  // back to the entity name for traders / NOCs whose primary
  // identity IS the operator.
  const ownershipQueryName = cap.operator ?? profile.name;

  const fmtUsd = (n: number | null) =>
    n != null ? `$${Math.round(n).toLocaleString()}` : '—';
  const tender = profile.publicTenderActivity;
  const sortedCategories = tender
    ? Object.entries(tender.awardsByCategory).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link
          href="/suppliers/known-entities"
          className="hover:text-[color:var(--color-foreground)]"
        >
          ← Known entities
        </Link>
        {' · '}
        <Link
          href="/suppliers/intelligence"
          className="hover:text-[color:var(--color-foreground)]"
        >
          Intelligence
        </Link>
      </nav>

      <header className="mb-6 overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] shadow-sm">
        <div className="h-32 bg-gradient-to-r from-sky-200 via-indigo-200 to-violet-200 sm:h-40" />
        <div className="px-4 pb-5 md:px-6">
          <div className="-mt-12 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
            <div className="flex items-end gap-4">
              <div className="rounded-full bg-[color:var(--color-background)] p-1 shadow-sm ring-1 ring-[color:var(--color-border)]">
                <EntityAvatar name={profile.name} size="xl" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:pb-1">
              <span className="rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2.5 py-1 text-xs text-[color:var(--color-muted-foreground)]">
                {profile.primarySource === 'known_entity'
                  ? 'curated rolodex'
                  : 'portal-scraped'}
              </span>
              <QualifyAsLeadButton slug={profile.canonicalKey} />
            </div>
          </div>
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{profile.name}</h1>
              <KycBadge
                status={approval?.status ?? null}
                size="lg"
                expiresAt={approval?.expiresAt ?? null}
              />
            </div>
            <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
              {[profile.role, profile.country].filter(Boolean).join(' · ') ||
                'Unknown'}
              {profile.aliases.length > 1 && (
                <>
                  {' · '}
                  <span title={profile.aliases.join(' • ')}>
                    aka {profile.aliases.filter((a) => a !== profile.name).slice(0, 2).join(', ')}
                    {profile.aliases.length > 3 ? ` (+${profile.aliases.length - 3})` : ''}
                  </span>
                </>
              )}
            </p>
            {profile.categories.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {profile.categories.slice(0, 6).map((cat) => (
                  <span
                    key={cat}
                    className="rounded-full bg-[color:var(--color-muted)]/50 px-2 py-0.5 text-[11px] text-[color:var(--color-muted-foreground)]"
                  >
                    {cat}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="mt-4 border-t border-[color:var(--color-border)] pt-4">
            <SupplierApprovalForm
              entitySlug={profile.canonicalKey}
              entityName={profile.name}
              initialStatus={approval?.status ?? null}
              initialExpiresAt={approval?.expiresAt ?? null}
              initialNotes={approval?.notes ?? null}
              entityTags={profile.tags}
            />
          </div>
        </div>
      </header>

      {(cap.capacityBpd != null ||
        cap.operator ||
        cap.owner ||
        cap.inceptionYear != null) && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            At a glance
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
            {cap.capacityBpd != null && (
              <InlineStat
                label="Capacity"
                value={`${(cap.capacityBpd / 1000).toFixed(0)}k bpd`}
              />
            )}
            {cap.operator && <InlineStat label="Operator" value={cap.operator} />}
            {cap.owner && cap.owner !== cap.operator && (
              <InlineStat label="Owner" value={cap.owner} />
            )}
            {cap.inceptionYear != null && (
              <InlineStat label="Started" value={String(cap.inceptionYear)} />
            )}
            {cap.status && <InlineStat label="Status" value={cap.status} />}
          </dl>
        </section>
      )}

      {/* Apollo corporate context — funding / headcount / revenue /
          tech stack. Reads from the cached snapshot populated by the
          nightly batch-enrichment cron. Streams in via Suspense so
          the cache lookup doesn't gate the header. */}
      <Suspense fallback={<SectionSkeleton title="Corporate context" rows={3} />}>
        <ApolloCorporateSection entitySlug={profile.canonicalKey} />
      </Suspense>

      {/* Website intelligence — facts + section summaries extracted
          from the entity's primary_domain crawl. Read-only for now;
          refresh action gated on Trigger.dev v3→v4 migration since
          a sync HTTP handler would time out on the ~60-120s crawl. */}
      <Suspense fallback={<SectionSkeleton title="Website intelligence" rows={3} />}>
        <WebsiteIntelligenceSection
          entitySlug={profile.canonicalKey}
          entityName={profile.name}
        />
      </Suspense>

      {/* Editable attributes (Pattern 2 per feedback-ui-brief.md §5).
          Inline-edit of high-leverage fields. Edits affect the entity
          globally and are logged to feedback_events as training labels
          for ML Component D attribute prediction. Only shown for
          known_entity-sourced rows — external_suppliers UUIDs don't
          map to the editable shape. */}
      {profile.primarySource === 'known_entity' && (
        <section className="mb-6 rounded-md border border-[color:var(--color-border)]/60 bg-[color:var(--color-muted)]/30 p-3">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Editable attributes
          </h2>
          <div className="space-y-1.5">
            <EditableAttribute
              entitySlug={profile.canonicalKey}
              attribute="role"
              label="Role"
              value={profile.role}
            />
            <EditableAttribute
              entitySlug={profile.canonicalKey}
              attribute="country"
              label="Country (ISO-2)"
              value={profile.country}
            />
            <EditableAttribute
              entitySlug={profile.canonicalKey}
              attribute="categories"
              label="Categories"
              value={profile.categories ?? []}
              multi
            />
            <EditableAttribute
              entitySlug={profile.canonicalKey}
              attribute="notes"
              label="Notes"
              value={profile.notes ?? null}
            />
          </div>
          <p className="mt-2 text-[10px] text-[color:var(--color-muted-foreground)]">
            Edits apply globally + log to feedback_events. Hover a field to reveal the ✏️ pencil; Enter saves, Esc cancels.
          </p>
        </section>
      )}

      {/* Pattern 4 (disposition tracking) per feedback-ui-brief.md §7.
          Per-user commercial-pursuit state. Stale-after-30d indicator
          surfaces here + inline whenever the entity is shown elsewhere
          (a future cross-surface integration). Only shown for known_entity
          rows since external_suppliers UUIDs aren't part of the
          analyst's commercial pipeline yet. */}
      {profile.primarySource === 'known_entity' && user && (
        <DispositionPanel entitySlug={profile.canonicalKey} current={currentDisposition} />
      )}

      {/* Quote anchors — refiner-only. Renders the realistic CIF
          mid for a default product into the desk's most-active dest
          ports so every refiner profile becomes a one-glance answer
          to "what could we quote out of here today." */}
      {profile.role === 'refiner' && (
        <QuoteAnchorsPanel entityCountry={profile.country ?? null} />
      )}

      {/* Slate × actual customs flow cross-reference (refiner) /
          declared volume × country flows (fuel-buyer). Streams in
          since both involve customs-flow joins; resolves to null
          for other roles. */}
      <Suspense fallback={null}>
        <ImportContextSection
          role={profile.role ?? null}
          entitySlug={profile.canonicalKey}
        />
      </Suspense>

      {/* Per-tenant document attachments — KYC packs, MSAs, contracts,
          datasheets, price sheets, compliance screens, correspondence.
          Per-tenant scoped (one tenant's docs never surface to another). */}
      <div className="mb-6">
        <EntityDocumentsPanel
          entitySlug={profile.canonicalKey}
          entityName={profile.name}
        />
      </div>

      {profile.latitude != null && profile.longitude != null && (
        <Suspense fallback={<SectionSkeleton title="Vessel activity" rows={4} />}>
          <VesselActivitySection
            lat={profile.latitude}
            lng={profile.longitude}
          />
        </Suspense>
      )}

      {/* Apollo decision-makers + external contact enrichments. Single
          fetch (`getContactEnrichmentsBySlug`) feeds both lists; render
          inside one Suspense boundary so the page doesn't double-flash. */}
      <Suspense fallback={<SectionSkeleton title="Decision-makers" rows={3} />}>
        <ContactsSection entitySlug={profile.canonicalKey} />
      </Suspense>

      {profile.categories.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {profile.categories.map((c) => (
              <span
                key={c}
                className="rounded-full bg-[color:var(--color-muted)]/50 px-3 py-1 text-xs"
              >
                {c}
              </span>
            ))}
          </div>
        </section>
      )}

      {profile.tags.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Tags
          </h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {profile.tags.map((t) => (
              <Link
                key={t}
                href={`/suppliers/known-entities?tag=${encodeURIComponent(t)}`}
                className="rounded-full border border-[color:var(--color-border)] px-3 py-1 text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
              >
                {t}
              </Link>
            ))}
          </div>
        </section>
      )}

      {profile.notes && (() => {
        const parsed = parseEntityNotes(profile.notes);
        // Fall back to the original blob render only when the parser
        // found nothing structured — i.e. notes is a plain one-liner
        // with no section markers. Most entities fall here; only the
        // analyst-curated assay-rich entries (NOC, refinery seed
        // entries) hit the sectioned path.
        const hasStructure =
          parsed.offer != null ||
          parsed.contact != null ||
          parsed.assaySections.length > 0 ||
          parsed.source != null;
        if (!hasStructure) {
          return (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Capability notes
              </h2>
              <p className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm leading-relaxed">
                {profile.notes}
              </p>
            </section>
          );
        }
        return (
          <>
            {parsed.description && (
              <section className="mb-6">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  About
                </h2>
                <p className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm leading-relaxed">
                  {parsed.description}
                </p>
              </section>
            )}

            {parsed.offer && (
              <section className="mb-6">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Active offer
                </h2>
                <p className="rounded-[var(--radius-lg)] border-l-4 border-[color:var(--color-foreground)] bg-amber-50/60 p-4 text-sm leading-relaxed">
                  {parsed.offer}
                </p>
              </section>
            )}

            {parsed.contact && (
              <section className="mb-6">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Contact
                </h2>
                <dl className="grid gap-2 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm sm:grid-cols-2">
                  {parsed.contact.address && (
                    <div className="sm:col-span-2">
                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Address
                      </dt>
                      <dd>{parsed.contact.address}</dd>
                    </div>
                  )}
                  {parsed.contact.tels.length > 0 && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Tel
                      </dt>
                      <dd className="space-y-0.5 tabular-nums">
                        {parsed.contact.tels.map((t) => (
                          <div key={t}>{t}</div>
                        ))}
                      </dd>
                    </div>
                  )}
                  {parsed.contact.faxes.length > 0 && (
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Fax
                      </dt>
                      <dd className="space-y-0.5 tabular-nums">
                        {parsed.contact.faxes.map((f) => (
                          <div key={f}>{f}</div>
                        ))}
                      </dd>
                    </div>
                  )}
                  {parsed.contact.emails.length > 0 && (
                    <div className="sm:col-span-2">
                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        Email
                      </dt>
                      <dd className="space-y-0.5">
                        {parsed.contact.emails.map((e) => (
                          <a
                            key={e}
                            href={`mailto:${e}`}
                            className="block hover:underline"
                          >
                            {e}
                          </a>
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>
              </section>
            )}

            {parsed.quickSpecs.length > 0 && (
              <section className="mb-6">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Key specs
                </h2>
                <dl className="grid grid-cols-2 gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm sm:grid-cols-3 md:grid-cols-4">
                  {parsed.quickSpecs.map((spec) => (
                    <div key={spec.label}>
                      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                        {spec.label}
                      </dt>
                      <dd className="tabular-nums">{spec.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {parsed.assaySections.length > 0 && (
              <section className="mb-6">
                <details className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20">
                  <summary className="cursor-pointer list-none px-4 py-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]">
                    Full assay ({parsed.assaySections.length}{' '}
                    {parsed.assaySections.length === 1 ? 'section' : 'sections'})
                    <span className="ml-2 text-[10px] normal-case">click to expand</span>
                  </summary>
                  <div className="border-t border-[color:var(--color-border)] p-4 text-sm">
                    {parsed.assaySections.map((sec, i) => (
                      <div key={sec.title} className={i > 0 ? 'mt-4' : ''}>
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                          {sec.title}
                        </h3>
                        <dl className="space-y-1">
                          {sec.rows.map((row, idx) => (
                            <div
                              key={`${row.label}-${idx}`}
                              className="grid grid-cols-[minmax(0,200px)_1fr] gap-3 leading-snug"
                            >
                              <dt className="text-[color:var(--color-muted-foreground)]">
                                {row.label || '—'}
                              </dt>
                              <dd className="tabular-nums">{row.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </div>
                </details>
              </section>
            )}

            {parsed.source && (
              <p className="mb-6 text-[11px] text-[color:var(--color-muted-foreground)]">
                Source: {parsed.source}
              </p>
            )}
          </>
        );
      })()}

      <Suspense fallback={<SectionSkeleton title="Ownership" rows={3} />}>
        <OwnershipSection
          ownershipQueryName={ownershipQueryName}
          operatorName={cap.operator ?? null}
          profileName={profile.name}
        />
      </Suspense>

      <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Public-tender activity
        </h2>
        {!tender ? (
          <p className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-4 text-sm text-[color:var(--color-muted-foreground)]">
            No public-tender awards in the supplier-graph for this entity. Either none yet ingested
            or this entity transacts via private commercial flows only — common for major Mediterranean
            refiners and trading houses. Use lookup_customs_flows or Kpler / Vortexa for private flow
            visibility.
          </p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Total awards" value={tender.totalAwards.toLocaleString()} />
              <Stat label="Total $USD" value={fmtUsd(tender.totalValueUsd)} />
              <Stat label="First award" value={tender.firstAwardDate ?? '—'} />
              <Stat label="Most recent" value={tender.mostRecentAwardDate ?? '—'} />
            </div>

            {sortedCategories.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Awards by category
                </h3>
                <div className="flex flex-wrap gap-2">
                  {sortedCategories.map(([tag, n]) => (
                    <span
                      key={tag}
                      className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs"
                    >
                      {tag} <span className="font-semibold">×{n}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Top buyers
                </h3>
                {tender.topBuyers.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-muted-foreground)]">No data.</p>
                ) : (
                  <ol className="space-y-1 text-sm">
                    {tender.topBuyers.map((b) => (
                      <li key={b.buyerName} className="flex justify-between gap-3">
                        <span className="truncate" title={b.buyerName}>
                          {b.buyerName}
                        </span>
                        <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                          {b.awardsCount} · {fmtUsd(b.totalValueUsd)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                  Recent awards
                </h3>
                {tender.recentAwards.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-muted-foreground)]">No data.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {tender.recentAwards.map((a, i) => (
                      <li
                        key={`${a.awardDate}-${a.buyerName}-${i}`}
                        className="flex justify-between gap-3"
                      >
                        <span className="truncate" title={a.title ?? a.buyerName}>
                          <span className="text-[color:var(--color-muted-foreground)]">
                            {a.awardDate}
                          </span>{' '}
                          {a.buyerName}
                        </span>
                        <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                          {fmtUsd(a.contractValueUsd)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {cap.wikidataId && (
        <section className="mb-6 text-xs text-[color:var(--color-muted-foreground)]">
          Source: Wikidata{' '}
          <a
            href={`https://www.wikidata.org/wiki/${cap.wikidataId}`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-[color:var(--color-foreground)]"
          >
            {cap.wikidataId}
          </a>
        </section>
      )}

      <footer className="mt-10 border-t border-[color:var(--color-border)] pt-4 text-xs text-[color:var(--color-muted-foreground)]">
        Profile composed from analyst rolodex (known_entities) + portal supplier registry
        (external_suppliers) + public-tender awards. Capability notes are editorial; treat as a
        starting point. Not a substitute for paid customs/AIS sources when current commercial flows
        matter.
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="mt-0.5 text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>
      )}
    </div>
  );
}

function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

