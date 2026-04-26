import Link from 'next/link';
import type { OpportunitySummary } from '../lib/queries';
import { formatMoney, timeUntil } from '../lib/format';

type Props = { op: OpportunitySummary };

/**
 * Strip glyphs that government portal HTML occasionally embeds and
 * that don't render in our font stack — Unicode replacement chars,
 * ballot-box / generic-square shapes used as bullets, zero-width
 * controls. Normal punctuation (em-dashes, ampersands) is preserved.
 *
 * NPTA in particular emits a checkbox-style separator between
 * sub-tenders that browsers render as a ballot-box glyph. We swap
 * to a middle-dot " · " so the text reads as a real list.
 *
 * The two regexes are built from string patterns rather than literals
 * so ESLint's no-control-regex / no-irregular-whitespace rules don't
 * trip on the very codepoints we exist to remove.
 */
const SQUARE_BULLET_RE = new RegExp(
  // FFFD = replacement char, 2610-2612 = ballot boxes, 25A0-25CF =
  // generic squares/triangles, E000-F8FF = Private Use Area where
  // portal HTML routinely embeds font-specific glyphs that render
  // as boxes in our stack.
  '[\\uFFFD\\u2610-\\u2612\\u25A0-\\u25CF\\uE000-\\uF8FF]',
  'g',
);
// C0 controls (excluding TAB \u0009, LF \u000A, CR \u000D so word
// boundaries survive), DEL, zero-width spaces / joiners, and BIDI
// direction marks. Stripping these glyphs is the entire point of
// this regex, hence the rule disable.
/* eslint-disable no-control-regex */
const CONTROL_AND_ZWS_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E]',
  'g',
);
/* eslint-enable no-control-regex */

function cleanText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(SQUARE_BULLET_RE, ' · ')
    .replace(CONTROL_AND_ZWS_RE, '')
    .replace(/(?: · ){2,}/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A handful of legacy / migration-imported rows have a slugified title
 * stuffed into `referenceNumber` — e.g.
 *   "GUYSUCO-Advertisement-Invitation-for-Bids-IFB-Agriculture-Equipments"
 * Real procurement references are short, structured ("IFB/MOE 03/2022",
 * "EDESUR-DAF-CM-2026-0003") and rarely exceed ~30 chars. Heuristic:
 * if the cleaned reference is long *and* dominated by hyphens *and* has
 * no slashes/colons/digits-with-slashes, treat it as a slug and hide it.
 * Better to omit a noisy field than to display garbage.
 */
function isSluggyReference(ref: string): boolean {
  if (ref.length < 35) return false;
  const hyphenRatio = (ref.match(/-/g)?.length ?? 0) / ref.length;
  const hasStructuredHints = /[/:]|\d{4}/.test(ref);
  return hyphenRatio > 0.08 && !hasStructuredHints;
}

export function OpportunityCard({ op }: Props) {
  const href = `/opportunities/${op.slug}`;
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const countdown = timeUntil(op.deadlineAt);
  const title = cleanText(op.title);
  const summaryText = cleanText(op.aiSummary ?? op.description);
  const cleanedRef = cleanText(op.referenceNumber);
  const referenceLabel = cleanedRef && !isSluggyReference(cleanedRef) ? cleanedRef : null;

  return (
    <article className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 transition hover:border-[color:var(--color-foreground)]">
      <header className="flex items-start justify-between gap-3">
        <JurisdictionBadge
          countryCode={op.jurisdictionCountry}
          name={op.jurisdictionName}
        />
        {countdown && (
          <span
            className={`text-xs font-medium ${
              countdown === 'closed'
                ? 'text-[color:var(--color-muted-foreground)]'
                : 'text-[color:var(--color-brand)]'
            }`}
          >
            {countdown === 'closed' ? 'Closed' : `Closes in ${countdown}`}
          </span>
        )}
      </header>

      <Link href={href} className="block">
        <h3 className="text-base font-semibold leading-snug group-hover:underline">{title}</h3>
      </Link>

      {summaryText ? (
        <p className="line-clamp-3 text-sm text-[color:var(--color-muted-foreground)]">
          {summaryText}
        </p>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-2 text-xs">
        <div className="text-[color:var(--color-muted-foreground)]">
          {op.agencyShort ?? op.agencyName ?? op.jurisdictionName}
          {referenceLabel && <span> · {referenceLabel}</span>}
        </div>
        {value && (
          <div className="text-right">
            <div className="font-medium text-[color:var(--color-foreground)]">{value}</div>
            {valueUsd && <div className="text-[color:var(--color-muted-foreground)]">≈ {valueUsd}</div>}
          </div>
        )}
      </footer>
    </article>
  );
}

/**
 * Country pill: ISO-2 code in a small uppercase mono badge. Replaces
 * the flag emoji, which rendered inconsistently across OS/browser
 * combinations and clashed with the otherwise minimalist B&W card
 * aesthetic. Tooltip carries the full jurisdiction name for a11y.
 */
function JurisdictionBadge({
  countryCode,
  name,
}: {
  countryCode: string | null | undefined;
  name: string;
}) {
  const code = (countryCode ?? '').toUpperCase().slice(0, 2) || '??';
  return (
    <span
      title={name}
      aria-label={name}
      className="inline-flex h-5 min-w-[2.5rem] items-center justify-center rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-1.5 font-mono text-[10px] font-semibold tracking-wider text-[color:var(--color-foreground)]"
    >
      {code}
    </span>
  );
}
