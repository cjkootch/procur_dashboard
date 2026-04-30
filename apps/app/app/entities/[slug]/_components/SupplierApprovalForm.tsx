'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplierApprovalStatus } from '@procur/db';
import { setSupplierApprovalAction } from '../actions';

/**
 * Manage approval state from the entity profile page.
 *
 * Three render modes, by initialStatus:
 *
 *  1. **null + has legacy tag** → amber "import the chat-curated KYC
 *     note as a tracked approval" callout. One-click button writes
 *     approved_with_kyc with no expiry. The user can still expand
 *     the full form for non-KYC variants.
 *
 *  2. **null** (no legacy tag) → primary "✓ Mark KYC Approved" CTA
 *     with a "More options" link that expands the full form. The
 *     CTA defaults to approved_with_kyc + no expiry — the most
 *     common state.
 *
 *  3. **non-null** → muted "Edit approval" link (collapsed by
 *     default; expands the form on click).
 */
export type SupplierApprovalFormProps = {
  entitySlug: string;
  entityName: string;
  initialStatus: SupplierApprovalStatus | null;
  initialExpiresAt: string | null;
  initialNotes: string | null;
  /** Free-text tags from known_entities.tags. Triggers the legacy-
   *  KYC callout when 'kyc-approved' is present without a row. */
  entityTags?: string[];
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
  entityTags = [],
}: SupplierApprovalFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SupplierApprovalStatus>(
    initialStatus ?? 'approved_with_kyc',
  );
  const [expiresAt, setExpiresAt] = useState(
    initialExpiresAt ? initialExpiresAt.slice(0, 10) : '',
  );
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [pending, startTransition] = useTransition();

  const hasLegacyKycTag =
    initialStatus == null && entityTags.some((t) => t === 'kyc-approved');

  /** One-click write — fires the action with the supplied status and
   *  whatever expiry / notes are currently in the form. Used by both
   *  the primary CTA and the legacy-tag import button. */
  const quickWrite = (newStatus: SupplierApprovalStatus, presetNotes?: string) => {
    startTransition(async () => {
      await setSupplierApprovalAction({
        entitySlug,
        entityName,
        status: newStatus,
        expiresAt: null,
        notes: presetNotes ?? null,
      });
      setOpen(false);
      router.refresh();
    });
  };

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

  // Mode 1: legacy `kyc-approved` tag, no structured row yet.
  if (hasLegacyKycTag && !open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
        <span className="text-amber-900">
          Chat-curated <code className="font-mono text-xs">kyc-approved</code>{' '}
          tag found — convert to a tracked approval to enable the badge + filter.
        </span>
        <button
          type="button"
          onClick={() =>
            quickWrite(
              'approved_with_kyc',
              'Imported from legacy kyc-approved tag.',
            )
          }
          disabled={pending}
          className="rounded-[var(--radius-sm)] bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Import as KYC Approved'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={pending}
          className="text-xs text-amber-900 underline hover:text-amber-700"
        >
          More options
        </button>
      </div>
    );
  }

  // Mode 2: not engaged, no legacy tag — primary CTA + "More options".
  if (initialStatus == null && !open) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => quickWrite('approved_with_kyc')}
          disabled={pending}
          className="rounded-[var(--radius-sm)] bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
        >
          {pending ? 'Saving…' : '✓ Mark KYC Approved'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={pending}
          className="text-xs text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
        >
          More options
        </button>
      </div>
    );
  }

  // Mode 3: engaged — collapsed "Edit approval" link.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-[color:var(--color-muted-foreground)] underline hover:text-[color:var(--color-foreground)]"
      >
        Edit approval
      </button>
    );
  }

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
