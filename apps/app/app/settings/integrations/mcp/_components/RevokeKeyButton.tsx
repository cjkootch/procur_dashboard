'use client';

import { useState, useTransition } from 'react';
import { revokeMcpApiKeyAction } from '../actions';

export function RevokeKeyButton({
  keyId,
  keyName,
}: {
  keyId: string;
  keyName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-[color:var(--color-muted)]/40"
      >
        Revoke
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[10px] text-[color:var(--color-muted-foreground)]">
        Revoke {keyName}?
      </span>
      <button
        type="button"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await revokeMcpApiKeyAction({ keyId });
            if (!result.ok) {
              setError(result.message ?? 'Revoke failed');
            }
          });
        }}
        disabled={pending}
        className="rounded-[var(--radius-md)] border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 hover:bg-amber-500/20 dark:text-amber-200 disabled:opacity-50"
      >
        {pending ? 'Revoking…' : 'Confirm'}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-[color:var(--color-muted)]/40"
      >
        Cancel
      </button>
      {error && <span className="text-[10px] text-amber-700">{error}</span>}
    </span>
  );
}
