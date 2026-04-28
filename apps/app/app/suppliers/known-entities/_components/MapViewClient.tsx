'use client';

/**
 * Thin client-side wrapper that dynamic-imports MapView with ssr:false.
 * Leaflet touches `window` at module-init, so it can't run during SSR;
 * dynamic + ssr:false defers it to the browser bundle.
 */
import dynamic from 'next/dynamic';
import type { MapEntity } from './MapView';

const MapView = dynamic(() => import('./MapView').then((m) => m.MapView), {
  ssr: false,
  loading: () => (
    <div
      className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]"
      style={{ height: '600px' }}
    >
      Loading map…
    </div>
  ),
});

export function MapViewClient({ entities }: { entities: MapEntity[] }) {
  return <MapView entities={entities} />;
}
