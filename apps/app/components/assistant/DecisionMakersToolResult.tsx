'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { enrichApolloPersonAction } from '../../app/entities/[slug]/actions';
import type { RenderedToolUse } from './types';

/**
 * Specialized tool-result renderer for `find_decision_makers_at_entity`.
 * The default ToolCard would dump the JSON output verbatim — useful for
 * debugging but noisy for the operator who just wants to see "who can
 * I reach at this entity, and which ones are already on file?"
 *
 * v3 (this file): bulk-enrich header button, single-pass loop over
 * unresolved rows, stops on first failure (including daily cap) with
 * a banner. Individual per-row buttons stay; they're disabled during
 * a bulk run so the operator can't accidentally double-fire on one
 * person.
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
  // Optional for back-compat with cached tool outputs from before the
  // tool started surfacing this. Treat missing as false so old rows
  // render as "No email" rather than silently green.
  enrichedHasEmail?: boolean;
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
 * Locally-resolved row keyed by apolloPersonId. Populated when an
 * inline (or bulk) enrich call succeeds; the renderer swaps the
 * obfuscated row for one of these without re-fetching the tool result.
 */
type ResolvedRow = {
  fullName: string;
  title: string | null;
  email: string | null;
  directPhone: string | null;
  linkedinUrl: string | null;
};

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

  // Locally-swapped rows live here; keyed by apolloPersonId.
  const [resolved, setResolved] = useState<Record<string, ResolvedRow>>({});

  // Per-row pending: lets the bulk loop disable individual buttons
  // and show "Enriching…" state on the row currently being resolved.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  // Bulk-run state. `bulkActive` blocks new bulk runs and disables
  // individual per-row buttons; `bulkError` surfaces the message
  // from whichever call broke the chain (typically the daily cap).
  const [bulkActive, setBulkActive] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [, startBulkTransition] = useTransition();

  // Hooks must run in stable order — derive count and handler before
  // any early-return branches. `people` lives behind a useMemo so the
  // unresolvedCount memo's deps array doesn't churn every render
  // (the `?? []` would otherwise allocate a fresh empty array each
  // pass).
  const people = useMemo<Row[]>(() => output?.people ?? [], [output?.people]);
  const unresolvedCount = useMemo(
    () =>
      people.filter(
        (p) => !p.alreadyEnriched && !resolved[p.apolloPersonId],
      ).length,
    [people, resolved],
  );

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

  if (people.length === 0) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2 text-xs text-[color:var(--color-muted-foreground)]">
        No matching decision-makers returned.
      </div>
    );
  }

  const runBulk = () => {
    if (!entitySlug || bulkActive) return;
    setBulkActive(true);
    setBulkError(null);
    startBulkTransition(async () => {
      try {
        // Sequential — Apollo's per-tenant cap is enforced server-
        // side per call, so parallel would just race to the same
        // 429. Sequential also lets us stop cleanly the moment the
        // cap is hit instead of finishing in-flight requests after.
        for (const p of people) {
          if (p.alreadyEnriched) continue;
          // Re-check `resolved` inside the loop because earlier
          // iterations of this same bulk run may have just resolved
          // it. (Redundant for now — apolloPersonId is unique per
          // search result — but cheap and future-proofs against
          // duplicate IDs in result sets.)
          const alreadyDone = resolved[p.apolloPersonId];
          if (alreadyDone) continue;

          setPendingIds((prev) => {
            const next = new Set(prev);
            next.add(p.apolloPersonId);
            return next;
          });
          const result = await enrichApolloPersonAction({
            entitySlug,
            apolloPersonId: p.apolloPersonId,
          });
          setPendingIds((prev) => {
            const next = new Set(prev);
            next.delete(p.apolloPersonId);
            return next;
          });

          if (!result.ok) {
            setBulkError(result.message);
            return; // Stop the chain; remaining rows stay unresolved.
          }

          setResolved((prev) => ({
            ...prev,
            [p.apolloPersonId]: {
              fullName: `${result.person.firstName} ${result.person.lastName}`.trim(),
              title: result.person.title,
              email: result.person.email,
              directPhone: result.person.directPhone,
              linkedinUrl: result.person.linkedinUrl,
            },
          }));
        }
      } finally {
        setBulkActive(false);
      }
    });
  };

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--color-border)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span>
          Decision-makers · {people.length}
          {output?.totalEntries && output.totalEntries > people.length
            ? ` of ${output.totalEntries}`
            : ''}
        </span>
        <div className="flex items-center gap-2">
          {entitySlug && unresolvedCount > 0 && (
            <button
              type="button"
              onClick={runBulk}
              disabled={bulkActive}
              className="rounded-full border border-[color:var(--color-foreground)]/50 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[color:var(--color-foreground)] hover:border-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40 disabled:opacity-40"
              title={`Enrich the ${unresolvedCount} unresolved contacts via Apollo /people/match (paid, per-tenant daily cap; stops on first failure)`}
            >
              {bulkActive ? 'Enriching…' : `Enrich all (${unresolvedCount})`}
            </button>
          )}
          {entitySlug && (
            <Link
              href={`/entities/${entitySlug}#decision-makers`}
              className="font-normal normal-case tracking-normal hover:text-[color:var(--color-foreground)]"
            >
              View on entity profile →
            </Link>
          )}
        </div>
      </header>
      {bulkError && (
        <div className="border-b border-amber-500/40 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-900">
          <span className="font-medium">Bulk enrich stopped: </span>
          <span className="text-amber-800/80">{bulkError}</span>
        </div>
      )}
      <ul className="divide-y divide-[color:var(--color-border)]">
        {people.map((p) => (
          <PersonRow
            key={p.apolloPersonId}
            row={p}
            entitySlug={entitySlug}
            resolvedHere={resolved[p.apolloPersonId] ?? null}
            individualDisabled={bulkActive}
            isBulkPendingHere={pendingIds.has(p.apolloPersonId)}
            onResolved={(r) =>
              setResolved((prev) => ({ ...prev, [p.apolloPersonId]: r }))
            }
          />
        ))}
      </ul>
    </div>
  );
}

function PersonRow({
  row,
  entitySlug,
  resolvedHere,
  individualDisabled,
  isBulkPendingHere,
  onResolved,
}: {
  row: Row;
  entitySlug: string | null;
  resolvedHere: ResolvedRow | null;
  individualDisabled: boolean;
  isBulkPendingHere: boolean;
  onResolved: (r: ResolvedRow) => void;
}) {
  const isResolved = resolvedHere !== null || row.alreadyEnriched;

  const displayName = resolvedHere
    ? resolvedHere.fullName
    : [row.firstName, row.lastNameObfuscated].filter(Boolean).join(' ');
  const displayTitle = resolvedHere?.title ?? row.title ?? null;

  return (
    <li className="flex items-start gap-2 px-2.5 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[color:var(--color-foreground)]">
          {displayName || '(unnamed)'}
        </div>
        <div className="truncate text-[color:var(--color-muted-foreground)]">
          {displayTitle ?? '—'}
          {row.organization ? ` · ${row.organization}` : ''}
        </div>
        {resolvedHere && (resolvedHere.email || resolvedHere.directPhone) && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
            {resolvedHere.email && (
              <a
                href={`mailto:${resolvedHere.email}`}
                className="hover:text-[color:var(--color-foreground)]"
              >
                {resolvedHere.email}
              </a>
            )}
            {resolvedHere.directPhone && (
              <a
                href={`tel:${resolvedHere.directPhone}`}
                className="hover:text-[color:var(--color-foreground)]"
              >
                {resolvedHere.directPhone}
              </a>
            )}
            {resolvedHere.linkedinUrl && (
              <a
                href={resolvedHere.linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[color:var(--color-foreground)]"
              >
                LinkedIn ↗
              </a>
            )}
          </div>
        )}
      </div>
      {isResolved ? (
        // Locally-resolved rows know their email directly; cached
        // already-enriched rows fall back to the tool's enrichedHasEmail
        // flag so we don't double-fetch.
        (resolvedHere?.email ?? null) != null || row.enrichedHasEmail ? (
          <EnrichedPill />
        ) : (
          <NoEmailPill />
        )
      ) : entitySlug ? (
        <EnrichInChatButton
          entitySlug={entitySlug}
          apolloPersonId={row.apolloPersonId}
          onResolved={onResolved}
          disabled={individualDisabled}
          forcePending={isBulkPendingHere}
        />
      ) : null}
    </li>
  );
}

function EnrichedPill() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
      title="Enriched via Apollo /people/match — verified email on file"
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden fill="currentColor">
        <path d="M4.5 8.5L2 6l-.7.7 3.2 3.2 6.5-6.5L10.3 3z" />
      </svg>
      Has email
    </span>
  );
}

function NoEmailPill() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      title="Enriched via Apollo, but no verified email was returned. Add a manual email on the entity profile or try an alternate contact."
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden fill="currentColor">
        <path d="M6 1.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zm-.5 2.5h1v3h-1V4zm0 4h1v1h-1V8z" />
      </svg>
      No email
    </span>
  );
}

function EnrichInChatButton({
  entitySlug,
  apolloPersonId,
  onResolved,
  disabled,
  forcePending,
}: {
  entitySlug: string;
  apolloPersonId: string;
  onResolved: (r: ResolvedRow) => void;
  disabled: boolean;
  forcePending: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [iconBroken, setIconBroken] = useState(false);

  if (error) {
    return (
      <span
        className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700"
        role="status"
        title={error}
      >
        {error.length > 24 ? `${error.slice(0, 22)}…` : error}
      </span>
    );
  }

  const isPending = pending || forcePending;

  return (
    <button
      type="button"
      onClick={() => {
        setError(null);
        startTransition(async () => {
          const result = await enrichApolloPersonAction({
            entitySlug,
            apolloPersonId,
          });
          if (!result.ok) {
            setError(result.message);
            return;
          }
          onResolved({
            fullName: `${result.person.firstName} ${result.person.lastName}`.trim(),
            title: result.person.title,
            email: result.person.email,
            directPhone: result.person.directPhone,
            linkedinUrl: result.person.linkedinUrl,
          });
        });
      }}
      disabled={disabled || isPending}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--color-foreground)]/40 px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-foreground)] hover:border-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40 disabled:opacity-40"
      title="Enrich this contact via Apollo /people/match (paid, per-tenant daily cap)"
    >
      {/* Apollo brand mark, rendered from /apollo-icon.svg in public/.
          Drop the official SVG (https://www.apollo.io/brand) into
          apps/app/public/apollo-icon.svg; the button silently falls
          back to a text-only label when the asset is missing or the
          image fails to load. We don't ship the logo in-repo to keep
          the PR free of third-party brand assets. */}
      {!iconBroken && (
        // 12px static SVG; next/image's loader pipeline buys nothing
        // here and breaks the silent-fallback-on-missing-asset
        // behavior we want from `onError`.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/apollo-icon.svg"
          alt=""
          aria-hidden
          className="h-3 w-3"
          onError={() => setIconBroken(true)}
        />
      )}
      <span>{isPending ? 'Enriching…' : 'Enrich'}</span>
    </button>
  );
}
