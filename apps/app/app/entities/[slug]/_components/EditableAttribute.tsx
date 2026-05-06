'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Editable single attribute on the entity profile per
 * docs/feedback-ui-brief.md §5. Click pencil to edit inline; save
 * with Enter, cancel with Esc. Edit POSTs to
 * /api/entities/[slug]/attribute which updates known_entities and
 * logs a feedback_events row (kind='entity_attribute') for ML
 * Component D training.
 *
 * Single-value strings only in v1; categories (string[]) edit comes
 * via the comma-separated input mode (split on save).
 */
export function EditableAttribute({
  entitySlug,
  attribute,
  label,
  value,
  /** Suggest these values in a dropdown when editing categorical
      fields. Caller computes from existing entity data. */
  commonValues,
  /** Comma-split mode for string[] fields (categories). */
  multi,
}: {
  entitySlug: string;
  attribute: 'name' | 'country' | 'role' | 'categories' | 'notes' | 'primary_domain';
  label: string;
  value: string | string[] | null;
  commonValues?: string[];
  multi?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(toDraft(value));
  const [recentlyEdited, setRecentlyEdited] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(toDraft(value));
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const submit = () => {
    const newValue = multi
      ? draft
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : draft.trim().length === 0
      ? null
      : draft.trim();
    startTransition(async () => {
      const res = await fetch(`/api/entities/${encodeURIComponent(entitySlug)}/attribute`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attribute, newValue }),
      });
      if (res.ok) {
        setEditing(false);
        setRecentlyEdited(true);
        // 24h "you edited this" indicator per brief §5.3 — but for
        // chat-thread density we fade after 5s rather than holding for
        // a full day. Persistent edit history view picks up the slack.
        setTimeout(() => setRecentlyEdited(false), 5_000);
        router.refresh();
      }
    });
  };

  const cancel = () => {
    setDraft(toDraft(value));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}:</span>
        {multi || (typeof value === 'string' && value.length > 80) ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            disabled={pending}
            rows={multi ? 2 : 4}
            className="min-w-[280px] flex-1 rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
              if (e.key === 'Enter') submit();
            }}
            disabled={pending}
            list={commonValues && commonValues.length > 0 ? `commonvals-${attribute}` : undefined}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
        )}
        {commonValues && commonValues.length > 0 && (
          <datalist id={`commonvals-${attribute}`}>
            {commonValues.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded border border-emerald-500/50 px-1.5 py-0.5 text-[11px] text-emerald-700 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          ✓
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={cancel}
          className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[11px] hover:border-[color:var(--color-foreground)] disabled:opacity-40"
        >
          ✗
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-baseline gap-2">
      <span className="text-xs text-[color:var(--color-muted-foreground)]">{label}:</span>
      <span className={`text-sm ${recentlyEdited ? 'bg-emerald-500/15 px-1' : ''}`}>
        {displayValue(value, multi)}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`Edit ${label}`}
        aria-label={`Edit ${label}`}
        className="opacity-0 group-hover:opacity-100 text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
      >
        ✏️
      </button>
    </div>
  );
}

function toDraft(value: string | string[] | null): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function displayValue(value: string | string[] | null, multi?: boolean): string {
  if (value == null || (Array.isArray(value) && value.length === 0)) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (multi) return value;
  return value;
}
