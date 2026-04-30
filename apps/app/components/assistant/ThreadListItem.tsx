'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export type ThreadListItemProps = {
  id: string;
  title: string;
  lastMessageAtIso: string;
  active: boolean;
};

export function ThreadListItem({ id, title, lastMessageAtIso, active }: ThreadListItemProps) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  // Two-step inline confirm replaces the blocking `confirm()` modal,
  // which was pinning the main thread for ~1.2s on every delete and
  // showing up as an INP regression. First click flips the Delete
  // button to a red "Confirm" state for CONFIRM_TIMEOUT_MS; second
  // click fires the request.
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === title) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/assistant/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next }),
    });
    setBusy(false);
    if (res.ok) {
      setRenaming(false);
      router.refresh();
    }
  };

  const CONFIRM_TIMEOUT_MS = 3000;
  const onDeleteClick = () => {
    if (!confirming) {
      setConfirming(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
      return;
    }
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirming(false);
    setBusy(true);
    // Fire-and-forget so the click handler returns immediately and
    // the next paint isn't blocked by the network round-trip.
    void fetch(`/api/assistant/threads/${id}`, { method: 'DELETE' }).then((res) => {
      setBusy(false);
      if (res.ok) {
        if (active) router.push('/assistant');
        else router.refresh();
      }
    });
  };

  const formattedDate = new Date(lastMessageAtIso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  if (renaming) {
    return (
      <li className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-1.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setRenaming(false);
          }}
          disabled={busy}
          className="w-full bg-transparent text-xs outline-none"
        />
        <div className="mt-1 flex gap-2 text-[10px]">
          <button onClick={() => void save()} disabled={busy} className="underline">
            Save
          </button>
          <button onClick={() => setRenaming(false)} className="text-[color:var(--color-muted-foreground)]">
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group">
      <div
        className={`relative rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[color:var(--color-background)] ${active ? 'bg-[color:var(--color-background)]' : ''}`}
      >
        <Link href={`/assistant/${id}`} className="block">
          <div className={`truncate text-xs ${active ? 'font-medium' : ''}`}>{title}</div>
          <div className="text-[10px] text-[color:var(--color-muted-foreground)]">
            {formattedDate}
          </div>
        </Link>
        <div className="absolute right-1 top-1 hidden gap-1 text-[10px] group-hover:flex">
          <button
            type="button"
            onClick={() => setRenaming(true)}
            disabled={busy}
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/80 px-1.5 py-0.5 text-[color:var(--color-muted-foreground)]"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onDeleteClick}
            disabled={busy}
            aria-label={confirming ? 'Click again to confirm delete' : 'Delete conversation'}
            className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-red-600 ${
              confirming
                ? 'bg-red-100 font-medium ring-1 ring-red-400'
                : 'bg-[color:var(--color-muted)]/80'
            }`}
          >
            {confirming ? 'Confirm?' : 'Delete'}
          </button>
        </div>
      </div>
    </li>
  );
}
