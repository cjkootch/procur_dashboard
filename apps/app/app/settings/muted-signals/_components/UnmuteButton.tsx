'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function UnmuteButton({
  entitySlug,
  signalType,
  signalSource,
}: {
  entitySlug: string;
  signalType: string;
  signalSource: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const unmute = () => {
    startTransition(async () => {
      const res = await fetch('/api/feedback/mute', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entitySlug,
          signalType,
          signalSource,
        }),
      });
      if (res.ok) router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={unmute}
      disabled={pending}
      className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
    >
      Un-mute
    </button>
  );
}
