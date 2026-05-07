'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { enrichApolloPersonAction } from '../../app/entities/[slug]/actions';
import type { RenderedToolUse } from './types';

/**
 * Specialized tool-result renderer for `find_decision_makers_at_entity`.
 * The default ToolCard would dump the JSON output verbatim — useful for
 * debugging but noisy for the operator who just wants to see "who can
 * I reach at this entity, and which ones are already on file?"
 *
 * v2 (this file): inline enrich button next to each unresolved row,
 * fires the same paid /people/match call the entity-profile button
 * uses — server-side per-tenant daily cap is the only credit-burn
 * gate. On success the row swaps to a confirmed-identity card with
 * full name + email + phone. Bulk enrich lands in PR 3.
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
 * Locally-resolved row keyed by apolloPersonId. Populated when an
 * inline enrich call succeeds; the renderer swaps the obfuscated row
 * for one of these without re-fetching the tool result.
 */
type ResolvedRow = {
  fullName: string;
  title: string | null;
  email: string | null;
  directPhone: string | null;
  linkedinUrl: string | null;
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

  // Locally-swapped rows live here. Keyed by apolloPersonId so the
  // map stays stable even if the underlying tool output shape changes
  // between renders.
  const [resolved, setResolved] = useState<Record<string, ResolvedRow>>({});

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
          <PersonRow
            key={p.apolloPersonId}
            row={p}
            entitySlug={entitySlug}
            resolvedHere={resolved[p.apolloPersonId] ?? null}
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
  onResolved,
}: {
  row: Row;
  entitySlug: string | null;
  resolvedHere: ResolvedRow | null;
  onResolved: (r: ResolvedRow) => void;
}) {
  // Three rendering states, cascading by precedence:
  //   1. Locally resolved this session → show full name + contacts.
  //   2. Server says alreadyEnriched (prior /people/match) → ✓ pill.
  //   3. Otherwise → inline Enrich affordance.
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
        <EnrichedPill />
      ) : entitySlug ? (
        <EnrichInChatButton
          entitySlug={entitySlug}
          apolloPersonId={row.apolloPersonId}
          onResolved={onResolved}
        />
      ) : null}
    </li>
  );
}

function EnrichedPill() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
      title="Already enriched via Apollo /people/match"
    >
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden fill="currentColor">
        <path d="M4.5 8.5L2 6l-.7.7 3.2 3.2 6.5-6.5L10.3 3z" />
      </svg>
      Enriched
    </span>
  );
}

function EnrichInChatButton({
  entitySlug,
  apolloPersonId,
  onResolved,
}: {
  entitySlug: string;
  apolloPersonId: string;
  onResolved: (r: ResolvedRow) => void;
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
      disabled={pending}
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
      <span>{pending ? 'Enriching…' : 'Enrich'}</span>
    </button>
  );
}
