'use client';

import { useClerk } from '@clerk/nextjs';

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'https://admin.procur.app';

/**
 * Sign out the impersonated session and return the staff member to the
 * admin app. Client component because Clerk's signOut is a browser-side
 * call that destroys the session cookie before redirecting.
 */
export function ExitImpersonationButton() {
  const { signOut } = useClerk();
  return (
    <button
      type="button"
      onClick={() => {
        void signOut({ redirectUrl: `${ADMIN_URL}/tenants` });
      }}
      className="rounded-[var(--radius-sm)] border border-amber-700 bg-amber-200 px-3 py-1 text-[11px] font-medium text-amber-950 hover:bg-amber-300"
    >
      Exit impersonation
    </button>
  );
}
