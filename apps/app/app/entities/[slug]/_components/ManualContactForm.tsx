'use client';

import { useState } from 'react';
import { addManualContactAction } from '../actions';

/**
 * Operator-side manual contact entry — the escape hatch when Apollo
 * can't match the entity (no Apollo org, no primary domain) or the
 * person isn't in Apollo's index. Lands in entity_contact_enrichments
 * with source='manual', confidence 1.00 (operator-asserted).
 *
 * Collapsed by default to keep the Decision-makers section visually
 * dominated by the Apollo flow when both are available; expands on
 * click for the manual path.
 */
export function ManualContactForm({ entitySlug }: { entitySlug: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);

  const onSubmit = async (formData: FormData) => {
    setBusy(true);
    setMessage(null);
    const result = await addManualContactAction(formData);
    setMessage({ kind: result.ok ? 'ok' : 'err', text: result.message });
    setBusy(false);
    if (result.ok) {
      // Collapse + clear the form on a successful save so the next
      // entry starts fresh.
      const form = document.getElementById(
        `manual-contact-form-${entitySlug}`,
      ) as HTMLFormElement | null;
      form?.reset();
    }
  };

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
        >
          + Add a contact manually
        </button>
        {message?.kind === 'ok' && (
          <p className="mt-1 text-xs text-green-700">{message.text}</p>
        )}
      </div>
    );
  }

  return (
    <form
      id={`manual-contact-form-${entitySlug}`}
      action={(fd) => void onSubmit(fd)}
      className="mt-3 grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Add a contact manually</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          ×
        </button>
      </div>
      <input type="hidden" name="entitySlug" value={entitySlug} />
      <label className="grid gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Full name *
        </span>
        <input
          type="text"
          name="fullName"
          required
          maxLength={200}
          placeholder="Murilo Soares"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Email
        </span>
        <input
          type="email"
          name="email"
          maxLength={200}
          placeholder="mro@vitol.com"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Title
        </span>
        <input
          type="text"
          name="title"
          maxLength={200}
          placeholder="Commercial Director"
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Phone
        </span>
        <input
          type="tel"
          name="phone"
          maxLength={40}
          placeholder="+41 22 ..."
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </label>
      <label className="grid gap-1">
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          LinkedIn URL
        </span>
        <input
          type="url"
          name="linkedinUrl"
          maxLength={400}
          placeholder="https://linkedin.com/in/..."
          disabled={busy}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="self-start rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1 text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save contact'}
      </button>
      {message && (
        <p
          className={
            message.kind === 'ok' ? 'text-green-700' : 'text-red-700'
          }
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
