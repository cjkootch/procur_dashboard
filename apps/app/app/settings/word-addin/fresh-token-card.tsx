'use client';

import { useEffect, useState } from 'react';
import { clearWordAddinFlashCookieAction } from './actions';

/**
 * Fresh-token card for the one-shot post-mint display.
 *
 * Why a client component: the server-rendered HTML carries the raw
 * token in the response, and we need to call a server action to delete
 * the flash cookie BEFORE any subsequent navigation can re-show it
 * (`cookies().delete()` is forbidden in Server Components, only
 * allowed in actions and route handlers).
 *
 * The card calls `clearWordAddinFlashCookieAction` on mount, then
 * fades the warning text after 60s — the cookie's max-age — so the
 * user sees a clear "this was a one-shot view" signal even if they
 * don't navigate away.
 */
export function FreshTokenCard({ token }: { token: string }) {
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    let active = true;
    void clearWordAddinFlashCookieAction()
      .catch(() => {
        // Worst case the cookie still expires in 60s; not fatal.
      })
      .finally(() => {
        if (active) setCleared(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-emerald-300 bg-emerald-50/50 p-5">
      <h2 className="text-sm font-semibold text-emerald-900">Token created</h2>
      <p className="mt-1 mb-3 text-xs text-emerald-900/80">
        Copy this token now — it will never be shown again. Paste it into the Procur
        task pane in Word to pair this device.
      </p>
      <div className="rounded-[var(--radius-sm)] bg-white border border-emerald-300 px-3 py-2 font-mono text-xs break-all">
        {token}
      </div>
      <p className="mt-2 text-[11px] text-emerald-900/70">
        {cleared
          ? 'This banner won’t reappear on refresh.'
          : 'Hiding this banner from future loads…'}
      </p>
    </section>
  );
}
