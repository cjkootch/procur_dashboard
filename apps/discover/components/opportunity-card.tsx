import Link from 'next/link';
import type { OpportunitySummary } from '../lib/queries';
import { formatDate, formatMoney, pickTranslated, timeUntil } from '../lib/format';

type Props = {
  op: OpportunitySummary;
  /** Primary language subtag from Accept-Language (en, es, pt, …).
   *  When the opportunity's source language differs and a translation
   *  exists on the row, render the translation instead of the original. */
  userLanguage?: string;
};

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

/**
 * Some agencies (Guyana Sugar Corp especially) pack multiple unrelated
 * sub-tenders into a single title separated by bullet glyphs:
 *   "Supply & Delivery of Bagasse... • Replacement of Auxiliary Carrier
 *    Head Shaft... • Supply and Delivery of Oil Centrifuge for Albion..."
 * That blows past the line-clamp and makes neighbouring cards look
 * tiny by comparison. Lift the first sub-item as the headline and
 * surface the remaining count as a badge.
 *
 * Also strips leading bullet markers ("• Supply..." → "Supply...").
 */
function splitBulletedTitle(text: string): { headline: string; extraCount: number } {
  const stripped = text.replace(/^[\s••·\-*]+/, '').trim();
  // Only treat as multi-item if separators are bullets, NOT regular
  // punctuation — otherwise we'd cut every sentence with a colon.
  const parts = stripped
    .split(/\s*[•·]\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 6);
  if (parts.length <= 1) return { headline: stripped, extraCount: 0 };
  return { headline: parts[0]!, extraCount: parts.length - 1 };
}

export function OpportunityCard({ op, userLanguage = 'en' }: Props) {
  // Some legacy / migration rows have a null slug — those have nowhere
  // to land on the detail page. Render an unlinked card rather than a
  // dead link to /opportunities/.
  const slug = op.slug?.trim();
  const href = slug ? `/opportunities/${slug}` : null;
  const value = formatMoney(op.valueEstimate, op.currency);
  const valueUsd = op.currency !== 'USD' ? formatMoney(op.valueEstimateUsd, 'USD') : null;
  const countdown = timeUntil(op.deadlineAt);
  // Resolve display copy per user-language preference. When the user
  // wants en and the opportunity is es, use the AI-pipeline translation
  // (parsedContent.translations.en) if it exists.
  const displayTitle =
    pickTranslated('title', op.title, op.language, op.translations, userLanguage) ?? op.title;
  const displaySummary = pickTranslated('summary', op.aiSummary, op.language, op.translations, userLanguage);
  const displayDescription = pickTranslated('description', op.description, op.language, op.translations, userLanguage);
  const cleanedTitle = cleanText(displayTitle);
  const { headline, extraCount } = splitBulletedTitle(cleanedTitle);
  const rawSummary = cleanText(displaySummary ?? displayDescription);
  // If the description is just a clone of the title (common with
  // scrapers that fall back to title when no description exists), drop
  // it — the card already shows the title and the duplicate just eats
  // visual space.
  const summaryText = rawSummary && rawSummary !== cleanedTitle ? rawSummary : '';
  const cleanedRef = cleanText(op.referenceNumber);
  const referenceLabel = cleanedRef && !isSluggyReference(cleanedRef) ? cleanedRef : null;

  return (
    <article
      className={`group relative flex h-full flex-col gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5 transition hover:border-[color:var(--color-foreground)] ${
        href ? 'cursor-pointer focus-within:border-[color:var(--color-foreground)]' : ''
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <JurisdictionBadge
            countryCode={op.jurisdictionCountry}
            name={op.jurisdictionName}
          />
          {op.beneficiaryCountry && (
            <span
              title={`Beneficiary: ${op.beneficiaryCountry}`}
              className="inline-flex h-5 items-center rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-1.5 text-[10px] font-medium text-[color:var(--color-foreground)]"
            >
              <span aria-hidden className="mr-1 text-[color:var(--color-muted-foreground)]">→</span>
              {op.beneficiaryCountry}
            </span>
          )}
        </div>
        {countdown && (
          <span
            className={`text-xs font-medium ${
              countdown === 'closed'
                ? 'text-[color:var(--color-muted-foreground)]'
                : 'text-[color:var(--color-brand)]'
            }`}
          >
            {countdown === 'closed'
              ? `Closed${op.deadlineAt ? ` ${formatDate(op.deadlineAt)}` : ''}`
              : `Closes in ${countdown}`}
          </span>
        )}
      </header>

      <h3
        className="line-clamp-2 text-base font-semibold leading-snug group-hover:underline"
        title={cleanedTitle}
      >
        {/*
          Stretched-link pattern: the anchor has no visible body, but its
          ::after fills the article so the entire card surface is the
          hit target. Title text stays selectable; footer/badge clicks
          still navigate. The whole card animates as one focusable unit.
        */}
        {href ? (
          <Link
            href={href}
            className="before:absolute before:inset-0 before:rounded-[var(--radius-lg)] before:content-['']"
          >
            <span className="relative">{headline}</span>
          </Link>
        ) : (
          headline
        )}
        {extraCount > 0 && (
          <span className="relative ml-1 inline-flex items-center rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-px align-middle text-[10px] font-medium text-[color:var(--color-muted-foreground)]">
            +{extraCount} more
          </span>
        )}
      </h3>

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
