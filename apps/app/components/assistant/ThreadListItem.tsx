'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

  const remove = async () => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    setBusy(true);
    const res = await fetch(`/api/assistant/threads/${id}`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) {
      if (active) router.push('/assistant');
      else router.refresh();
    }
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
            onClick={() => void remove()}
            disabled={busy}
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/80 px-1.5 py-0.5 text-red-600"
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}
