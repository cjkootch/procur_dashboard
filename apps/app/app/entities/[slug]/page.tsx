import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  getContactEnrichmentsBySlug,
  getDirectOwners,
  getEntityProfile,
  getEntityVesselActivity,
  getOwnershipChain,
  getSupplierApproval,
} from '@procur/catalog';
import { KycBadge } from '../../../components/KycBadge';
import { parseEntityNotes } from '../../../lib/entity-notes';
import { PushToVexButton } from './_components/PushToVexButton';
import { EntityDocumentsPanel } from './_components/EntityDocumentsPanel';
import { QuoteAnchorsPanel } from './_components/QuoteAnchorsPanel';
import { SupplierApprovalForm } from './_components/SupplierApprovalForm';

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

  const { company } = await requireCompany();
  const approval = await getSupplierApproval(company.id, profile.canonicalKey);

  // Walk the ownership chain. Try the operator first (refineries usually
  // store operator in metadata.operator and that's the one whose parents
  // matter for sovereign-backing analysis); fall back to the entity name
  // itself for traders / NOCs whose primary identity IS the operator.
  const cap = profile.capabilities;
  const ownershipQueryName = cap.operator ?? profile.name;
  const [directOwners, ownershipChain, vesselActivity, contactEnrichments] =
    await Promise.all([
      getDirectOwners(ownershipQueryName),
      getOwnershipChain(ownershipQueryName, 5),
      profile.latitude != null && profile.longitude != null
        ? getEntityVesselActivity({
            lat: profile.latitude,
            lng: profile.longitude,
            radiusNm: 50,
            daysBack: 30,
            recentLimit: 10,
          }).catch(() => null)
        : Promise.resolve(null),
      getContactEnrichmentsBySlug(profile.canonicalKey).catch(() => []),
    ]);

  const fmtUsd = (n: number | null) =>
    n != null ? `$${Math.round(n).toLocaleString()}` : '—';
  const tender = profile.publicTenderActivity;
  const sortedCategories = tender
    ? Object.entries(tender.awardsByCategory).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
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

      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{profile.name}</h1>
            <KycBadge
              status={approval?.status ?? null}
              size="lg"
              expiresAt={approval?.expiresAt ?? null}
            />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              {profile.primarySource === 'known_entity'
                ? 'curated rolodex'
                : 'portal-scraped'}
            </span>
            <PushToVexButton slug={profile.canonicalKey} />
          </div>
        </div>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          {profile.country ?? 'Unknown country'}
          {profile.role && ` · ${profile.role}`}
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
        <SupplierApprovalForm
          entitySlug={profile.canonicalKey}
          entityName={profile.name}
          initialStatus={approval?.status ?? null}
          initialExpiresAt={approval?.expiresAt ?? null}
          initialNotes={approval?.notes ?? null}
          entityTags={profile.tags}
        />
      </header>

      {(cap.capacityBpd != null ||
        cap.operator ||
        cap.owner ||
        cap.inceptionYear != null) && (
        <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {cap.capacityBpd != null && (
            <Stat
              label="Capacity"
              value={`${(cap.capacityBpd / 1000).toFixed(0)}k bpd`}
            />
          )}
          {cap.operator && <Stat label="Operator" value={cap.operator} />}
          {cap.owner && cap.owner !== cap.operator && <Stat label="Owner" value={cap.owner} />}
          {cap.inceptionYear != null && (
            <Stat label="Started" value={String(cap.inceptionYear)} />
          )}
          {cap.status && <Stat label="Status" value={cap.status} />}
        </section>
      )}

      {/* Quote anchors — refiner-only. Renders the realistic CIF
          mid for a default product into the desk's most-active dest
          ports so every refiner profile becomes a one-glance answer
          to "what could we quote out of here today." */}
      {profile.role === 'refiner' && (
        <QuoteAnchorsPanel entityCountry={profile.country ?? null} />
      )}

      {/* Per-tenant document attachments — KYC packs, MSAs, contracts,
          datasheets, price sheets, compliance screens, correspondence.
          Per-tenant scoped (one tenant's docs never surface to another). */}
      <div className="mb-6">
        <EntityDocumentsPanel
          entitySlug={profile.canonicalKey}
          entityName={profile.name}
        />
      </div>


      {vesselActivity && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Vessel activity
          </h2>
          <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
            {vesselActivity.callsLast30d === 0 && vesselActivity.nearbyPorts.length === 0 ? (
              <p className="text-xs text-[color:var(--color-muted-foreground)]">
                No tanker calls within 50 nm of this location in the last 30 days. Either the AISStream
                feed has no coverage in this region (current bboxes: Med · NW Indian Ocean · Caribbean)
                or no port within 50 nm of the entity is seeded — populate <code className="rounded bg-[color:var(--color-muted)]/40 px-1">ports</code> with a closer entry to enable
                call detection.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="Calls 24h" value={vesselActivity.callsLast24h.toString()} />
                  <Stat label="Calls 7d" value={vesselActivity.callsLast7d.toString()} />
                  <Stat label="Calls 30d" value={vesselActivity.callsLast30d.toString()} />
                  <Stat
                    label="Nearby ports"
                    value={vesselActivity.nearbyPorts.length.toString()}
                    sub={
                      vesselActivity.nearbyPorts.length > 0
                        ? `closest ${vesselActivity.nearbyPorts[0]!.distanceNm.toFixed(1)} nm`
                        : undefined
                    }
                  />
                </div>

                {vesselActivity.nearbyPorts.length > 0 && (
                  <div className="mt-3 border-t border-[color:var(--color-border)] pt-3">
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
                      Calls per port (30d)
                    </div>
                    <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                      {vesselActivity.nearbyPorts.slice(0, 6).map((p) => (
                        <li key={p.slug} className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            {p.name}{' '}
                            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
                              ({p.distanceNm.toFixed(1)} nm)
                            </span>
                          </span>
                          <span className="shrink-0 tabular-nums text-[color:var(--color-muted-foreground)]">
                            {p.calls7d} / {p.calls30d}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {vesselActivity.recentVessels.length > 0 && (
                  <details className="mt-3 border-t border-[color:var(--color-border)] pt-3 text-xs">
                    <summary className="cursor-pointer text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] [&::-webkit-details-marker]:hidden">
                      Recent vessels ▾
                    </summary>
                    <ul className="mt-2 flex flex-col divide-y divide-[color:var(--color-border)]/40">
                      {vesselActivity.recentVessels.map((v) => (
                        <li
                          key={`${v.mmsi}-${v.portSlug}-${v.lastSeenAt}`}
                          className="grid grid-cols-[1fr_140px_120px] items-baseline gap-2 py-1 tabular-nums"
                        >
                          <span className="truncate">
                            {v.vesselName ?? `MMSI ${v.mmsi}`}
                            {v.flagCountry && (
                              <span className="ml-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                                ({v.flagCountry})
                              </span>
                            )}
                          </span>
                          <span className="truncate text-[color:var(--color-muted-foreground)]">
                            {v.portName}
                          </span>
                          <span className="text-right text-[10px] text-[color:var(--color-muted-foreground)]">
                            {new Date(v.lastSeenAt).toLocaleDateString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <p className="mt-3 text-[10px] italic text-[color:var(--color-muted-foreground)]">
                  Calls inferred from AIS positions clustered inside each port&apos;s geofence at
                  &lt; 2 kn (anchored or moored). One call = one (vessel × port) cluster within 30 days.
                </p>
              </>
            )}
          </div>
        </section>
      )}

      {contactEnrichments.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            <span>
              Contacts{' '}
              <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
                ({contactEnrichments.length})
              </span>
            </span>
            <span className="font-normal normal-case tracking-normal text-[10px]">
              enriched by external integrations
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {contactEnrichments.map((c) => (
              <ContactCard key={c.id} contact={c} />
            ))}
          </div>
          <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
            Discoveries from connected integrations (vex CRM today). Procur treats these
            as suggestions — they don&apos;t overwrite your primary contact-of-record.
            Confidence dots reflect the source&apos;s certainty.
          </p>
        </section>
      )}

      {profile.categories.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {profile.categories.map((c) => (
              <span
                key={c}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs"
              >
                {c}
              </span>
            ))}
          </div>
        </section>
      )}

      {profile.tags.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Tags
          </h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {profile.tags.map((t) => (
              <Link
                key={t}
                href={`/suppliers/known-entities?tag=${encodeURIComponent(t)}`}
                className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 hover:border-[color:var(--color-foreground)]"
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

      {(directOwners.length > 0 || ownershipChain.length > 1) && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Ownership
            {cap.operator && cap.operator !== profile.name && (
              <span className="ml-2 font-normal normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
                (resolved via operator: {cap.operator})
              </span>
            )}
          </h2>

          {directOwners.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Direct owners
              </h3>
              <ul className="space-y-1 text-sm">
                {directOwners.map((o) => (
                  <li key={o.gemId} className="flex justify-between gap-3">
                    <span>
                      {o.name}
                      {o.shareImputed && (
                        <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">
                          (imputed)
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[color:var(--color-muted-foreground)] tabular-nums">
                      {o.sharePct != null ? `${o.sharePct.toFixed(1)}%` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {ownershipChain.length > 1 && (
            <div>
              <h3 className="mb-1 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                Ultimate-parent chain
              </h3>
              <p className="text-sm leading-relaxed">
                {ownershipChain.map((node, i) => (
                  <span key={`${node.gemId}-${i}`}>
                    {i > 0 && (
                      <span className="text-[color:var(--color-muted-foreground)]">
                        {' '}→{' '}
                        {node.sharePct != null && (
                          <span className="tabular-nums">[{node.sharePct.toFixed(0)}%] </span>
                        )}
                      </span>
                    )}
                    <span className={i === 0 ? 'font-medium' : ''}>{node.name}</span>
                  </span>
                ))}
              </p>
            </div>
          )}

          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            Source: GEM Global Energy Ownership Tracker (CC-BY-4.0). Imputed shares are GEM
            estimates from public records; direct shares are published values.
          </p>
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
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

type ContactCardData = {
  id: string;
  contactName: string;
  source: string;
  enrichedAt: string;
  email: { value: string; confidence: number; sourceUrl: string | null } | null;
  title: { value: string; confidence: number; sourceUrl: string | null } | null;
  phone: { value: string; confidence: number; sourceUrl: string | null } | null;
  linkedinUrl:
    | { value: string; confidence: number; sourceUrl: string | null }
    | null;
};

function ContactCard({ contact }: { contact: ContactCardData }) {
  return (
    <article className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 shadow-sm">
      <header className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{contact.contactName}</h3>
          {contact.title && (
            <p className="truncate text-xs text-[color:var(--color-muted-foreground)]">
              {contact.title.value}
            </p>
          )}
        </div>
        <span
          className="shrink-0 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
          title={`Discovered ${formatRelative(contact.enrichedAt)}`}
        >
          via {contact.source}
        </span>
      </header>
      <dl className="space-y-1.5 text-xs">
        {contact.email && (
          <ContactField
            icon="✉"
            href={`mailto:${contact.email.value}`}
            value={contact.email.value}
            confidence={contact.email.confidence}
            sourceUrl={contact.email.sourceUrl}
          />
        )}
        {contact.phone && (
          <ContactField
            icon="☎"
            href={`tel:${contact.phone.value}`}
            value={contact.phone.value}
            confidence={contact.phone.confidence}
            sourceUrl={contact.phone.sourceUrl}
          />
        )}
        {contact.linkedinUrl && (
          <ContactField
            icon="in"
            href={contact.linkedinUrl.value}
            value={contact.linkedinUrl.value.replace(/^https?:\/\/(www\.)?/, '')}
            confidence={contact.linkedinUrl.confidence}
            sourceUrl={contact.linkedinUrl.sourceUrl}
            external
          />
        )}
        {contact.title?.sourceUrl && !contact.email && !contact.phone && !contact.linkedinUrl && (
          // Title-only contact — surface the source so the card isn't blank.
          <ContactField
            icon="•"
            href={contact.title.sourceUrl}
            value={contact.title.sourceUrl.replace(/^https?:\/\/(www\.)?/, '')}
            confidence={contact.title.confidence}
            sourceUrl={null}
            external
          />
        )}
      </dl>
    </article>
  );
}

function ContactField({
  icon,
  href,
  value,
  confidence,
  sourceUrl,
  external,
}: {
  icon: string;
  href: string;
  value: string;
  confidence: number;
  sourceUrl: string | null;
  external?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-[color:var(--color-muted)]/60 text-[10px] text-[color:var(--color-muted-foreground)]"
        aria-hidden
      >
        {icon}
      </span>
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="min-w-0 flex-1 truncate hover:underline"
        title={value}
      >
        {value}
      </a>
      <ConfidenceDots confidence={confidence} />
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
          title={`Source: ${sourceUrl}`}
        >
          src↗
        </a>
      )}
    </div>
  );
}

function ConfidenceDots({ confidence }: { confidence: number }) {
  // 0.0–0.59 = 1 dot, 0.6–0.79 = 2 dots, 0.8–1.0 = 3 dots.
  // Vex's filter is ≥ 0.6 so we'll typically see 2 or 3.
  const filled = confidence >= 0.8 ? 3 : confidence >= 0.6 ? 2 : 1;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      title={`Confidence ${(confidence * 100).toFixed(0)}%`}
      aria-label={`Confidence ${(confidence * 100).toFixed(0)}%`}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`block h-1 w-1 rounded-full ${
            i < filled
              ? 'bg-[color:var(--color-foreground)]'
              : 'bg-[color:var(--color-border)]'
          }`}
        />
      ))}
    </span>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const days = Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
