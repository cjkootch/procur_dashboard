'use client';

import { useClerk } from '@clerk/nextjs';

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'https://admin.procur.app';

/**
 * Sign out the impersonated session and return the staff member to the
 * admin app. Client component because Clerk's signOut is a browser-side
 * call that destroys the session cookie before redirecting.
 *
 * Before signing out, fires a beacon to /api/impersonation-end so the
 * audit log gets a paired `impersonation_ended` row. Awaited (not a
 * fire-and-forget beacon) so the row lands while the session cookie
 * still authorizes the request — Clerk's signOut clears it.
 */
export function ExitImpersonationButton() {
  const { signOut } = useClerk();
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await fetch('/api/impersonation-end', { method: 'POST' });
        } catch {
          // Audit is best-effort; the started event already exists.
        }
        await signOut({ redirectUrl: `${ADMIN_URL}/tenants` });
      }}
      className="rounded-[var(--radius-sm)] border border-amber-700 bg-amber-200 px-3 py-1 text-[11px] font-medium text-amber-950 hover:bg-amber-300"
    >
      Exit impersonation
    </button>
  );
}
