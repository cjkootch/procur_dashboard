import { getDataFreshness, getPortsForMap, getRecentVesselTracks } from '@procur/catalog';
import { VesselMapClient } from './_components/VesselMapClient';
import type { PortPoint, VesselPoint } from './_components/VesselMap';

export const dynamic = 'force-dynamic';

/**
 * Vessel intelligence map. Surfaces every vessel that pinged AIS in
 * the last `daysBack` window, alongside the port reference layer
 * (loading terminals, refineries, transshipment hubs).
 *
 * Data flow:
 *   AISStream.io WebSocket  →  ingest-aisstream worker
 *      →  vessel_positions + vessels  →  this page (lazy reads,
 *                                        no materialized layer).
 *
 * Operational note: ingest-aisstream is bounded-duration (10 min
 * default) and not yet on a Trigger.dev cron — the freshness strip
 * at the bottom of the page tells the user when the most-recent
 * position landed. Wiring the cron is a small follow-up.
 */

interface Props {
  searchParams: Promise<{
    days?: string;
    /** [[latSW,lngSW],[latNE,lngNE]] joined as "lat1,lng1,lat2,lng2". */
    bbox?: string;
  }>;
}

const PRESETS: Array<{ label: string; bbox: string }> = [
  { label: 'Mediterranean', bbox: '30,-10,47,36' },
  { label: 'NW Indian Ocean', bbox: '5,40,27,80' },
  { label: 'Caribbean', bbox: '8,-90,25,-58' },
];

export default async function VesselsPage({ searchParams }: Props) {
  const params = await searchParams;
  const daysBack = clampDays(params.days);
  const bbox = parseBbox(params.bbox);

  const [vessels, ports, freshness] = await Promise.all([
    safe<VesselPoint[]>(() =>
      getRecentVesselTracks({ daysBack, bbox: bbox ?? undefined, limit: 1000 }) as Promise<VesselPoint[]>,
    ),
    safe<PortPoint[]>(() => getPortsForMap() as Promise<PortPoint[]>),
    safe(() => getDataFreshness()),
  ]);

  const v = vessels ?? [];
  const p = ports ?? [];
  const lastSeen =
    freshness?.vesselPositions?.latest != null
      ? new Date(freshness.vesselPositions.latest)
      : null;
  const totalPositions = freshness?.vesselPositions?.count ?? 0;

  return (
    <div className="mx-auto max-w-7xl px-6 py-6 bg-[color:var(--color-muted)]/40 min-h-[calc(100vh-49px)]">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Vessel intelligence</h1>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Recent tanker activity from the AISStream.io free AIS feed (MIT-licensed).
          Each vessel marker is its latest known position; the trailing line shows up
          to 20 prior positions in the {daysBack}-day window. Ports are color-coded by
          type. Click a marker for details.
        </p>
      </header>

      {/* Filter strip */}
      <section className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Window:
        </span>
        {[3, 7, 14, 30].map((d) => (
          <FilterChip
            key={d}
            href={buildHref({ days: String(d), bbox: params.bbox })}
            label={`${d}d`}
            active={daysBack === d}
          />
        ))}
        <span className="ml-3 text-[10px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          Region:
        </span>
        <FilterChip
          href={buildHref({ days: params.days, bbox: undefined })}
          label="World"
          active={!params.bbox}
        />
        {PRESETS.map((preset) => (
          <FilterChip
            key={preset.label}
            href={buildHref({ days: params.days, bbox: preset.bbox })}
            label={preset.label}
            active={params.bbox === preset.bbox}
          />
        ))}
      </section>

      {/* Map */}
      <VesselMapClient
        vessels={v}
        ports={p}
        totalPositions={totalPositions}
        lastSeenIso={lastSeen ? lastSeen.toISOString() : null}
        resetHref="/suppliers/vessels"
      />

      {/* Freshness footer */}
      <section className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 text-[11px]">
        <Stat
          label="Position rows"
          value={totalPositions.toLocaleString()}
          sub="all-time vessel_positions"
        />
        <Stat
          label="Last AIS ping"
          value={lastSeen ? formatRelative(lastSeen) : '—'}
          sub={lastSeen ? lastSeen.toLocaleString() : 'no pings yet'}
        />
        <Stat
          label="Ingest"
          value="ingest-aisstream"
          sub={
            'WebSocket worker, bounded-duration. Not yet on cron — wire the Trigger.dev wrapper to keep this fresh.'
          }
        />
      </section>
    </div>
  );
}

function buildHref(params: {
  days?: string;
  bbox?: string;
}): string {
  const sp = new URLSearchParams();
  if (params.days) sp.set('days', params.days);
  if (params.bbox) sp.set('bbox', params.bbox);
  const qs = sp.toString();
  return `/suppliers/vessels${qs ? `?${qs}` : ''}`;
}

function clampDays(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 90) return 7;
  return n;
}

function parseBbox(
  raw: string | undefined,
): [[number, number], [number, number]] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number.parseFloat(s));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return [
    [parts[0]!, parts[1]!],
    [parts[2]!, parts[3]!],
  ];
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error('[vessels] query failed:', err);
    return null;
  }
}

function FilterChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  const base = 'rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] font-medium';
  const cls = active
    ? `${base} border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]`
    : `${base} border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]`;
  // Anchor (server-friendly) — search-param navigation doesn't need
  // a Link prefetch.
  return (
    <a href={href} className={cls}>
      {label}
    </a>
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
    <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-2.5 shadow-sm">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </div>
      <div className="font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="text-[10px] text-[color:var(--color-muted-foreground)]">{sub}</div>
      )}
    </div>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
