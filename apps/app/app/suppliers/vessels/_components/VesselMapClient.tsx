'use client';

/**
 * SSR-safe wrapper for VesselMap. Leaflet touches `window` at module
 * init; dynamic + ssr:false defers it to the browser bundle. Mirrors
 * the MapViewClient pattern for known-entities.
 *
 * Mobile guard: an interactive AIS map is unusable below ~768px wide
 * (touch targets too small, zoom UI fights with page scroll, and the
 * Leaflet bundle is wasted bytes for a map you can't read). On narrow
 * viewports we render a placeholder card instead — the dynamic import
 * never fires because the component never mounts, so the Leaflet
 * payload stays out of the mobile bundle entirely.
 */
import { useEffect, useState } from 'react';
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

const DESKTOP_QUERY = '(min-width: 768px)';

export function VesselMapClient({
  vessels,
  ports,
  totalPositions,
  lastSeenIso,
  resetHref,
}: {
  vessels: VesselPoint[];
  ports: PortPoint[];
  totalPositions: number;
  lastSeenIso: string | null;
  resetHref: string;
}) {
  // Default to mobile during SSR + first paint so we don't briefly
  // render the map on a narrow client before the matchMedia check.
  // Switches to desktop once the client measures the viewport.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (!isDesktop) {
    return (
      <div
        className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)] shadow-sm"
        style={{ minHeight: 240 }}
      >
        <div className="font-medium text-[color:var(--color-foreground)]">
          Vessel map is desktop-only
        </div>
        <p className="mt-1.5 text-xs">
          {vessels.length.toLocaleString()} vessels · {ports.length.toLocaleString()} ports
          available in the current window. Open this page on a wider screen
          (≥ 768px) to interact with the AIS layer — the filter chips above
          still work for narrowing the dataset for desktop later.
        </p>
      </div>
    );
  }

  return (
    <VesselMap
      vessels={vessels}
      ports={ports}
      totalPositions={totalPositions}
      lastSeenIso={lastSeenIso}
      resetHref={resetHref}
    />
  );
}
