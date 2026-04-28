'use client';

import Link from 'next/link';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * Leaflet map view of known_entities. Server component (the page)
 * fetches the rows and passes them as props; this client component
 * handles the rendering.
 *
 * Roles get distinct marker colors so a glance at the map distinguishes
 * refineries, traders, producers, and state buyers.
 */

export type MapEntity = {
  slug: string;
  name: string;
  country: string;
  role: string;
  categories: string[];
  tags: string[];
  notes: string | null;
  metadata: Record<string, unknown> | null;
  latitude: number;
  longitude: number;
};

const ROLE_COLORS: Record<string, string> = {
  refiner: '#2563eb', // blue
  trader: '#ea580c', // orange
  producer: '#16a34a', // green
  'state-buyer': '#9333ea', // purple
  'power-plant': '#dc2626', // red — refined-fuel buyer
};

function makeIcon(color: string): L.DivIcon {
  // Inline SVG marker — no external pin asset needed.
  const svg = `
    <svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 20 12 20s12-11 12-20c0-6.627-5.373-12-12-12z" fill="${color}" stroke="white" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="4.5" fill="white"/>
    </svg>
  `;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [24, 32],
    iconAnchor: [12, 32],
    popupAnchor: [0, -28],
  });
}

/** Adjust map bounds to fit all markers when entities change. */
function FitBounds({ entities }: { entities: MapEntity[] }) {
  const map = useMap();
  useEffect(() => {
    if (entities.length === 0) return;
    const bounds = L.latLngBounds(entities.map((e) => [e.latitude, e.longitude]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6 });
  }, [entities, map]);
  return null;
}

export function MapView({ entities }: { entities: MapEntity[] }) {
  if (entities.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
        No entities with coordinates match these filters. Most curated refineries have lat/lng;
        rolodex entries without coordinates (some trading houses, multinationals) are list-only.
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-[color:var(--color-muted-foreground)]">
        {Object.entries(ROLE_COLORS).map(([role, color]) => (
          <span key={role} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: color, border: '1px solid white', boxShadow: '0 0 0 1px rgba(0,0,0,0.1)' }}
            />
            {role}
          </span>
        ))}
        <span className="ml-auto">
          {entities.length} entit{entities.length === 1 ? 'y' : 'ies'} on map
        </span>
      </div>

      <div
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]"
        style={{ height: '600px' }}
      >
        <MapContainer
          center={[20, 20]}
          zoom={2}
          minZoom={2}
          worldCopyJump
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds entities={entities} />
          {entities.map((e) => {
            const icon = makeIcon(ROLE_COLORS[e.role] ?? '#737373');
            const meta = e.metadata ?? {};
            const cap =
              typeof meta.capacity_bpd === 'number' ? meta.capacity_bpd : null;
            const operator =
              typeof meta.operator === 'string' ? meta.operator : null;
            return (
              <Marker
                key={e.slug}
                position={[e.latitude, e.longitude]}
                icon={icon}
              >
                <Popup>
                  <div style={{ minWidth: 220 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      <Link
                        href={`/entities/${encodeURIComponent(e.slug)}`}
                        style={{ color: '#2563eb', textDecoration: 'underline' }}
                      >
                        {e.name}
                      </Link>
                    </div>
                    <div style={{ fontSize: 12, color: '#525252' }}>
                      {e.country} · {e.role}
                    </div>
                    {cap != null && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        {(cap / 1000).toFixed(0)}k bpd
                        {operator ? ` · ${operator}` : ''}
                      </div>
                    )}
                    {e.categories.length > 0 && (
                      <div style={{ fontSize: 11, marginTop: 6, color: '#737373' }}>
                        {e.categories.slice(0, 3).join(' · ')}
                      </div>
                    )}
                    {e.notes && (
                      <div
                        style={{
                          fontSize: 11,
                          marginTop: 6,
                          color: '#404040',
                          maxWidth: 240,
                        }}
                      >
                        {e.notes.length > 160 ? e.notes.slice(0, 160) + '…' : e.notes}
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
    </>
  );
}
