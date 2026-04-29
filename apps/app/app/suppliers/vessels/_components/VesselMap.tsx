'use client';

import { useEffect } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Leaflet map of recent vessel activity.
 *
 * Two layers:
 *   - Ports (CircleMarker, color-coded by port_type) — static reference.
 *   - Vessels (CircleMarker at latest position + a polyline trail back
 *     through up to 20 prior positions) — live activity.
 *
 * Server component (the page) fetches both datasets and passes them
 * as props; this client component only handles rendering. Stale-time
 * is whatever the fetch caches at; for true live tracking the page
 * would need polling/streaming, which is a follow-up.
 */

export type VesselPoint = {
  mmsi: string;
  vesselName: string | null;
  imo: string | null;
  shipTypeLabel: string | null;
  flagCountry: string | null;
  lat: number;
  lng: number;
  speedKnots: number | null;
  timestamp: string;
  trail: Array<{ lat: number; lng: number; timestamp: string }>;
};

export type PortPoint = {
  slug: string;
  name: string;
  country: string;
  portType: string;
  lat: number;
  lng: number;
  geofenceRadiusNm: number;
};

const PORT_COLORS: Record<string, string> = {
  'crude-loading': '#dc2626', // red — Libyan loading terminals etc.
  refinery: '#2563eb', // blue
  transshipment: '#16a34a', // green
  mixed: '#9333ea', // purple
};

const VESSEL_COLOR_MOVING = '#ea580c'; // orange — under way
const VESSEL_COLOR_AT_REST = '#0ea5e9'; // sky — speed < 2 kn (anchored / moored)

function FitBounds({
  vessels,
  ports,
}: {
  vessels: VesselPoint[];
  ports: PortPoint[];
}) {
  const map = useMap();
  useEffect(() => {
    const points: Array<[number, number]> = [];
    for (const v of vessels) points.push([v.lat, v.lng]);
    for (const p of ports) points.push([p.lat, p.lng]);
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 6 });
  }, [vessels, ports, map]);
  return null;
}

export function VesselMap({
  vessels,
  ports,
}: {
  vessels: VesselPoint[];
  ports: PortPoint[];
}) {
  if (vessels.length === 0 && ports.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
        No vessel positions in the lookback window. Ensure{' '}
        <code className="rounded bg-[color:var(--color-muted)]/40 px-1">ingest-aisstream</code>{' '}
        has run recently — see the page footer for the freshness indicator.
      </div>
    );
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[color:var(--color-muted-foreground)]">
        <span className="flex items-center gap-1.5">
          <Dot color={VESSEL_COLOR_MOVING} /> vessel under way
        </span>
        <span className="flex items-center gap-1.5">
          <Dot color={VESSEL_COLOR_AT_REST} /> vessel at rest (≤2 kn)
        </span>
        {Object.entries(PORT_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1.5">
            <Dot color={color} ring />
            {type.replace(/-/g, ' ')}
          </span>
        ))}
        <span className="ml-auto">
          {vessels.length} vessel{vessels.length === 1 ? '' : 's'} · {ports.length} port
          {ports.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)] shadow-sm">
        <MapContainer
          center={[35, 18]}
          zoom={4}
          scrollWheelZoom
          style={{ height: '70vh', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds vessels={vessels} ports={ports} />

          {/* Port markers as ringed circles. Renders below vessels so
              vessels at port stay visible. */}
          {ports.map((p) => (
            <CircleMarker
              key={`port-${p.slug}`}
              center={[p.lat, p.lng]}
              radius={6}
              pathOptions={{
                color: PORT_COLORS[p.portType] ?? '#6b7280',
                fillColor: 'white',
                fillOpacity: 1,
                weight: 2.5,
              }}
            >
              <Popup>
                <div className="text-xs">
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-[color:var(--color-muted-foreground)]">
                    {p.country} · {p.portType.replace(/-/g, ' ')}
                  </div>
                  <div className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                    geofence radius: {p.geofenceRadiusNm.toFixed(1)} nm
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}

          {/* Vessel trails — render before the latest-position marker
              so the head sits above the polyline tail. */}
          {vessels.map((v) => {
            if (v.trail.length < 2) return null;
            const positions = v.trail.map(
              (t) => [t.lat, t.lng] as [number, number],
            );
            return (
              <Polyline
                key={`trail-${v.mmsi}`}
                positions={positions}
                pathOptions={{
                  color:
                    v.speedKnots != null && v.speedKnots >= 2
                      ? VESSEL_COLOR_MOVING
                      : VESSEL_COLOR_AT_REST,
                  weight: 1.5,
                  opacity: 0.5,
                }}
              />
            );
          })}

          {/* Vessel latest-position markers. */}
          {vessels.map((v) => {
            const moving = v.speedKnots != null && v.speedKnots >= 2;
            const color = moving ? VESSEL_COLOR_MOVING : VESSEL_COLOR_AT_REST;
            return (
              <CircleMarker
                key={`vessel-${v.mmsi}`}
                center={[v.lat, v.lng]}
                radius={4}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.9,
                  weight: 1,
                }}
              >
                <Popup>
                  <div className="text-xs">
                    <div className="font-semibold">
                      {v.vesselName ?? `MMSI ${v.mmsi}`}
                    </div>
                    <div className="text-[color:var(--color-muted-foreground)]">
                      {[v.shipTypeLabel, v.flagCountry].filter(Boolean).join(' · ')}
                    </div>
                    {v.imo && (
                      <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
                        IMO {v.imo} · MMSI {v.mmsi}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                      {v.speedKnots != null
                        ? `${v.speedKnots.toFixed(1)} kn`
                        : 'speed unknown'}{' '}
                      · last seen {new Date(v.timestamp).toLocaleString()}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
    </>
  );
}

function Dot({ color, ring }: { color: string; ring?: boolean }) {
  return (
    <span
      className="inline-block h-3 w-3 rounded-full"
      style={
        ring
          ? {
              backgroundColor: 'white',
              border: `2px solid ${color}`,
            }
          : {
              backgroundColor: color,
            }
      }
    />
  );
}
