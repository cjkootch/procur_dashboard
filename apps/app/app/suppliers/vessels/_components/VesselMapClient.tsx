'use client';

/**
 * SSR-safe wrapper for VesselMap. Leaflet touches `window` at module
 * init; dynamic + ssr:false defers it to the browser bundle. Mirrors
 * the MapViewClient pattern for known-entities.
 */
import dynamic from 'next/dynamic';
import type { PortPoint, VesselPoint } from './VesselMap';

const VesselMap = dynamic(() => import('./VesselMap').then((m) => m.VesselMap), {
  ssr: false,
  loading: () => (
    <div
      className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]"
      style={{ height: '70vh' }}
    >
      Loading map…
    </div>
  ),
});

export function VesselMapClient({
  vessels,
  ports,
}: {
  vessels: VesselPoint[];
  ports: PortPoint[];
}) {
  return <VesselMap vessels={vessels} ports={ports} />;
}
