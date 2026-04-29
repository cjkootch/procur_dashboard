import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getDirectOwners,
  getEntityProfile,
  getEntityVesselActivity,
  getOwnershipChain,
} from '@procur/catalog';

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

  // Walk the ownership chain. Try the operator first (refineries usually
  // store operator in metadata.operator and that's the one whose parents
  // matter for sovereign-backing analysis); fall back to the entity name
  // itself for traders / NOCs whose primary identity IS the operator.
  const cap = profile.capabilities;
  const ownershipQueryName = cap.operator ?? profile.name;
  const [directOwners, ownershipChain, vesselActivity] = await Promise.all([
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
          <h1 className="text-2xl font-semibold tracking-tight">{profile.name}</h1>
          <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {profile.primarySource === 'known_entity'
              ? 'curated rolodex'
              : 'portal-scraped'}
          </span>
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

      {profile.notes && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Capability notes
          </h2>
          <p className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm leading-relaxed">
            {profile.notes}
          </p>
        </section>
      )}

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
