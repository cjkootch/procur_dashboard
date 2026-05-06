'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const STATUSES = [
  { value: 'logged', label: 'Logged' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'wontfix', label: "Won't fix" },
] as const;

type Status = (typeof STATUSES)[number]['value'];

export function FrictionStatusPicker({
  feedbackEventId,
  current,
}: {
  feedbackEventId: string;
  current: Status;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<Status>(current);

  const onChange = (next: Status) => {
    setValue(next);
    startTransition(async () => {
      const res = await fetch(`/api/feedback/friction/${feedbackEventId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) router.refresh();
    });
  };

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Status)}
      disabled={pending}
      className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1.5 py-0.5 text-[11px] disabled:opacity-40"
    >
      {STATUSES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  );
}
