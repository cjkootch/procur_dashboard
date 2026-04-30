'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplierApprovalStatus } from '@procur/db';
import { setSupplierApprovalAction } from '../actions';

/**
 * Manage approval state from the entity profile page. The badge
 * itself is rendered by the parent (server component); this card
 * appears below it as the write surface — collapsed by default,
 * expands when the user clicks Edit.
 */
export type SupplierApprovalFormProps = {
  entitySlug: string;
  entityName: string;
  initialStatus: SupplierApprovalStatus | null;
  initialExpiresAt: string | null;
  initialNotes: string | null;
};

const STATUS_OPTIONS: Array<{ value: SupplierApprovalStatus; label: string }> = [
  { value: 'pending', label: 'Outreach Pending' },
  { value: 'kyc_in_progress', label: 'KYC In Progress' },
  { value: 'approved_without_kyc', label: 'Approved (No KYC)' },
  { value: 'approved_with_kyc', label: 'KYC Approved' },
  { value: 'expired', label: 'KYC Expired' },
  { value: 'rejected', label: 'Rejected' },
];

export function SupplierApprovalForm({
  entitySlug,
  entityName,
  initialStatus,
  initialExpiresAt,
  initialNotes,
}: SupplierApprovalFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(initialStatus == null);
  const [status, setStatus] = useState<SupplierApprovalStatus>(
    initialStatus ?? 'pending',
  );
  const [expiresAt, setExpiresAt] = useState(
    initialExpiresAt ? initialExpiresAt.slice(0, 10) : '',
  );
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
      >
        Edit approval
      </button>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      await setSupplierApprovalAction({
        entitySlug,
        entityName,
        status,
        expiresAt: expiresAt || null,
        notes: notes.trim() || null,
      });
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 p-4 md:grid-cols-2"
    >
      <label className="md:col-span-2">
        <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">
          Approval status
        </span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as SupplierApprovalStatus)}
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">
          KYC expires (optional)
        </span>
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        />
      </label>

      <label className="md:col-span-2">
        <span className="text-xs font-medium text-[color:var(--color-muted-foreground)]">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Approver name, contract ref, conditions…"
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        />
      </label>

      <div className="flex gap-2 md:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save approval'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
