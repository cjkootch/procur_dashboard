import Link from 'next/link';
import type { RenderedToolUse } from './types';

/**
 * Specialized tool-result renderer for `find_decision_makers_at_entity`.
 * The default ToolCard would dump the JSON output verbatim — useful for
 * debugging but noisy for the operator who just wants to see "who can
 * I reach at this entity, and which ones are already on file?"
 *
 * v1 (this file): static list, ✓ for already-enriched contacts, an
 * "Enrich" link to the entity profile for the rest. Inline enrich +
 * bulk lands in follow-up PRs (#2 and #3 of the chat-decision-makers
 * series).
 */

type Row = {
  apolloPersonId: string;
  firstName: string | null;
  lastNameObfuscated: string | null;
  title: string | null;
  hasEmail: boolean | null;
  hasDirectPhone: string | null;
  organization: string | null;
  alreadyEnriched: boolean;
};

type Output = {
  degraded?: boolean;
  reason?: string;
  message?: string;
  peopleCount?: number;
  totalEntries?: number;
  people?: Row[];
};

type Input = {
  entitySlug?: string;
};

/**
 * Match-guard: confirms the tool output is the shape we expect before
 * the renderer dereferences it. The streaming pipeline can deliver
 * partial output, an error envelope, or a degraded-mode response —
 * fall back to JSON dump in those cases.
 */
export function isFindDecisionMakersOutput(value: unknown): value is Output {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['degraded'] === true) return true;
  return Array.isArray(v['people']);
}

export function DecisionMakersToolResult({
  toolUse,
}: {
  toolUse: RenderedToolUse;
}) {
  const output = toolUse.result?.output as Output | undefined;
  const input = (toolUse.input ?? {}) as Input;
  const entitySlug = input.entitySlug ?? null;

  if (output?.degraded) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-amber-500/40 bg-amber-50/60 p-2 text-xs text-amber-900">
        <div className="font-medium">Decision-makers unavailable</div>
        <div className="mt-0.5 text-amber-800/80">
          {output.message ?? output.reason ?? 'Unknown error.'}
        </div>
      </div>
    );
  }

  const people = output?.people ?? [];
  if (people.length === 0) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2 text-xs text-[color:var(--color-muted-foreground)]">
        No matching decision-makers returned.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--color-border)]">
      <header className="flex items-baseline justify-between border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span>
          Decision-makers · {people.length}
          {output?.totalEntries && output.totalEntries > people.length
            ? ` of ${output.totalEntries}`
            : ''}
        </span>
        {entitySlug && (
          <Link
            href={`/entities/${entitySlug}#decision-makers`}
            className="font-normal normal-case tracking-normal hover:text-[color:var(--color-foreground)]"
          >
            View on entity profile →
          </Link>
        )}
      </header>
      <ul className="divide-y divide-[color:var(--color-border)]">
        {people.map((p) => (
          <PersonRow key={p.apolloPersonId} row={p} entitySlug={entitySlug} />
        ))}
      </ul>
    </div>
  );
}

function PersonRow({
  row,
  entitySlug,
}: {
  row: Row;
  entitySlug: string | null;
}) {
  const displayName = [row.firstName, row.lastNameObfuscated]
    .filter(Boolean)
    .join(' ');
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[color:var(--color-foreground)]">
          {displayName || '(unnamed)'}
        </div>
        <div className="truncate text-[color:var(--color-muted-foreground)]">
          {row.title ?? '—'}
          {row.organization ? ` · ${row.organization}` : ''}
        </div>
      </div>
      {row.alreadyEnriched ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
          title="Already enriched via Apollo /people/match"
        >
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            aria-hidden
            fill="currentColor"
          >
            <path d="M4.5 8.5L2 6l-.7.7 3.2 3.2 6.5-6.5L10.3 3z" />
          </svg>
          Enriched
        </span>
      ) : entitySlug ? (
        <Link
          href={`/entities/${entitySlug}#decision-makers`}
          className="shrink-0 rounded-full border border-[color:var(--color-foreground)]/40 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-foreground)] hover:border-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40"
          title="Open the entity profile to enrich this contact (paid, per-tenant daily cap)"
        >
          Enrich →
        </Link>
      ) : null}
    </li>
  );
}
