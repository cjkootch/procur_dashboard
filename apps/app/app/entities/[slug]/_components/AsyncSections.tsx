import {
  getApolloEntityCache,
  getContactEnrichmentsBySlug,
  getDirectOwners,
  getEntityVesselActivity,
  getEntityWebIntelligence,
  getFuelBuyerImportContext,
  getOwnershipChain,
  getRefineryImportContext,
} from '@procur/catalog';
import { ApolloCorporateContext } from './ApolloCorporateContext';
import { ApolloDecisionMakers } from './ApolloDecisionMakers';
import { ManualContactForm } from './ManualContactForm';
import { FuelBuyerImportContextPanel } from './FuelBuyerImportContextPanel';
import { RefineryImportContextPanel } from './RefineryImportContextPanel';
import { WebsiteIntelligencePanel } from './WebsiteIntelligencePanel';

/**
 * Async server-component wrappers around the slow per-section data
 * fetches on /entities/[slug]. Each one awaits a single query (or a
 * tightly-coupled pair) so it can sit inside its own <Suspense>
 * boundary in the page; the header renders without waiting on
 * vessel-activity / Apollo / website-intelligence (the long poles).
 */

export async function ApolloCorporateSection({
  entitySlug,
}: {
  entitySlug: string;
}) {
  const cache = await getApolloEntityCache(entitySlug).catch(() => null);
  return <ApolloCorporateContext cache={cache} entitySlug={entitySlug} />;
}

export async function WebsiteIntelligenceSection({
  entitySlug,
  entityName,
}: {
  entitySlug: string;
  entityName: string;
}) {
  const intel = await getEntityWebIntelligence(entitySlug).catch(() => null);
  return (
    <WebsiteIntelligencePanel
      intel={intel}
      entityName={entityName}
      entitySlug={entitySlug}
    />
  );
}

export async function ImportContextSection({
  role,
  entitySlug,
}: {
  role: string | null;
  entitySlug: string;
}) {
  if (role === 'refiner') {
    const ctx = await getRefineryImportContext(entitySlug).catch(() => null);
    if (!ctx || ctx.rows.length === 0) return null;
    return <RefineryImportContextPanel ctx={ctx} />;
  }
  if (role === 'fuel-buyer-industrial') {
    const ctx = await getFuelBuyerImportContext(entitySlug).catch(() => null);
    if (!ctx) return null;
    return <FuelBuyerImportContextPanel ctx={ctx} />;
  }
  return null;
}

type VesselActivity = Awaited<ReturnType<typeof getEntityVesselActivity>>;

export async function VesselActivitySection({
  lat,
  lng,
}: {
  lat: number;
  lng: number;
}) {
  const vesselActivity: VesselActivity | null = await getEntityVesselActivity({
    lat,
    lng,
    radiusNm: 50,
    daysBack: 30,
    recentLimit: 10,
  }).catch(() => null);
  if (!vesselActivity) return null;
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Vessel activity
      </h2>
      <div>
        {vesselActivity.callsLast30d === 0 && vesselActivity.nearbyPorts.length === 0 ? (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            No tanker calls within 50 nm of this location in the last 30 days. Either the AISStream
            feed has no coverage in this region (current bboxes: Med · NW Indian Ocean · Caribbean)
            or no port within 50 nm of the entity is seeded — populate{' '}
            <code className="rounded bg-[color:var(--color-muted)]/40 px-1">ports</code> with a
            closer entry to enable call detection.
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
  );
}

export async function OwnershipSection({
  ownershipQueryName,
  operatorName,
  profileName,
}: {
  ownershipQueryName: string;
  operatorName: string | null;
  profileName: string;
}) {
  const [directOwners, ownershipChain] = await Promise.all([
    getDirectOwners(ownershipQueryName),
    getOwnershipChain(ownershipQueryName, 5),
  ]);
  if (directOwners.length === 0 && ownershipChain.length <= 1) return null;
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Ownership
        {operatorName && operatorName !== profileName && (
          <span className="ml-2 font-normal normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
            (resolved via operator: {operatorName})
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
  );
}

type ContactEnrichments = Awaited<ReturnType<typeof getContactEnrichmentsBySlug>>;

export async function ContactsSection({
  entitySlug,
}: {
  entitySlug: string;
}) {
  const contactEnrichments: ContactEnrichments = await getContactEnrichmentsBySlug(
    entitySlug,
  ).catch(() => []);
  return (
    <>
      <ApolloDecisionMakers
        contacts={contactEnrichments}
        entitySlug={entitySlug}
      />
      <ManualContactForm entitySlug={entitySlug} />
      {contactEnrichments.filter((c) => c.source !== 'apollo').length > 0 && (
        <ExternalContactList contacts={contactEnrichments} />
      )}
    </>
  );
}

function ExternalContactList({
  contacts,
}: {
  contacts: ContactEnrichments;
}) {
  const externals = contacts.filter((c) => c.source !== 'apollo');
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span>
          Contacts{' '}
          <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
            ({externals.length})
          </span>
        </span>
        <span className="font-normal normal-case tracking-normal text-[10px]">
          enriched by external integrations
        </span>
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {externals.map((c) => (
          <ContactCard key={c.id} contact={c} />
        ))}
      </div>
      <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Discoveries from connected integrations. Procur treats these as
        suggestions — they don&apos;t overwrite your primary contact-of-record.
        Confidence dots reflect the source&apos;s certainty.
      </p>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

type ContactCardData = ContactEnrichments[number];

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

export function SectionSkeleton({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <section
      aria-busy
      className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm"
    >
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title}
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-[color:var(--color-muted)]/50"
            style={{ width: `${65 + ((i * 11) % 30)}%` }}
          />
        ))}
      </div>
    </section>
  );
}
