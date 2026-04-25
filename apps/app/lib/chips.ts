/**
 * Market-agnostic chip vocabulary for opportunity / pursuit cards.
 *
 * Designed to translate cleanly across Caribbean, LatAm, African, and other
 * developing-market procurement systems. Avoids US-federal-specific terms
 * (e.g. "8(a)", "SAM.gov", "Sources Sought") in favor of categories that
 * exist in every government procurement regime.
 *
 * Chip categories:
 *   - lifecycle  derived from deadline state
 *   - source     where the row entered Procur
 *   - type       procurement procedure (Open, Restricted, EOI, etc.)
 *   - funding    Government / Multilateral / Donor / Mixed
 *   - preference Local / MSME / JV-eligible — buyer-side eligibility flags
 *
 * Each chip has a label, a tone (color bucket), and an optional title for
 * the hover tooltip. Cards render chips with `chipClass(tone)` so colors
 * stay consistent platform-wide.
 */

export type ChipTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent';

export type Chip = {
  label: string;
  tone: ChipTone;
  title?: string;
};

// -- Tone → Tailwind class bucket --------------------------------------------

export function chipClass(tone: ChipTone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-500/15 text-emerald-700';
    case 'warning':
      return 'bg-amber-500/15 text-amber-700';
    case 'danger':
      return 'bg-red-500/15 text-red-700';
    case 'info':
      return 'bg-blue-500/15 text-blue-700';
    case 'accent':
      return 'bg-violet-500/15 text-violet-700';
    case 'neutral':
    default:
      return 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]';
  }
}

// -- Lifecycle chips (derived from deadline) ---------------------------------

import { LIFECYCLE_DAYS, P_WIN_BANDS } from './thresholds';

const DAY_MS = 24 * 60 * 60 * 1000;

export function lifecycleChip(deadlineAt: Date | null): Chip | null {
  if (!deadlineAt) return null;
  const diff = deadlineAt.getTime() - Date.now();
  if (diff < 0) return { label: 'Past Due', tone: 'danger', title: 'Submission deadline has passed' };
  const days = diff / DAY_MS;
  if (days <= LIFECYCLE_DAYS.dueSoon) {
    return {
      label: 'Due Soon',
      tone: 'warning',
      title: `Closing within ${LIFECYCLE_DAYS.dueSoon} days`,
    };
  }
  if (days <= LIFECYCLE_DAYS.closingSoon) {
    return {
      label: 'Closing Soon',
      tone: 'warning',
      title: `Closing within ${LIFECYCLE_DAYS.closingSoon} days`,
    };
  }
  return null;
}

// -- Source chips (where the row came from) ----------------------------------

const SOURCE_CHIPS: Record<string, Chip> = {
  scraper: { label: 'Discover', tone: 'neutral', title: 'Sourced from Procur Discover' },
  manual: { label: 'Manual', tone: 'neutral', title: 'Added by your team' },
  alert: { label: 'Alert match', tone: 'info', title: 'Matched a saved alert profile' },
};

export function sourceChip(source: 'scraper' | 'manual' | 'alert' | string | null | undefined): Chip | null {
  if (!source) return null;
  return SOURCE_CHIPS[source] ?? null;
}

// -- Procurement type chips --------------------------------------------------

/**
 * Map of common procurement-procedure names across the markets we cover.
 * Lower-case keys; the matcher normalizes input so DR's "Comparación de
 * Precios" and Trinidad's "RFP" both classify cleanly.
 *
 * If an unmapped value comes in (e.g. a brand-new procedure name from a
 * scraper), the chip is rendered as-is with a neutral tone — better to show
 * the raw value than silently drop it.
 */
const TYPE_CHIPS: Array<{ match: RegExp; chip: Chip }> = [
  { match: /\b(rfp|request for proposal)\b/i, chip: { label: 'RFP', tone: 'info' } },
  { match: /\b(rfq|request for quotation)\b/i, chip: { label: 'RFQ', tone: 'info' } },
  { match: /\b(itb|invitation to bid)\b/i, chip: { label: 'ITB', tone: 'info' } },
  {
    match: /\b(eoi|expression of interest|manifestaci[oó]n de inter[eé]s)\b/i,
    chip: { label: 'EOI', tone: 'accent', title: 'Expression of Interest' },
  },
  {
    match: /\b(pq|prequalification|pre-qualification)\b/i,
    chip: { label: 'PQ', tone: 'accent', title: 'Pre-qualification' },
  },
  {
    match: /\b(licitaci[oó]n p[uú]blica|open tender|public tender)\b/i,
    chip: { label: 'Open Tender', tone: 'info' },
  },
  {
    match: /\b(comparaci[oó]n de precios|price comparison|shopping)\b/i,
    chip: { label: 'Price Comparison', tone: 'info' },
  },
  {
    match: /\b(restricted|limited|invited|selective)\b/i,
    chip: { label: 'Restricted', tone: 'accent' },
  },
  {
    match: /\b(sole source|single source|direct contracting)\b/i,
    chip: { label: 'Sole Source', tone: 'warning' },
  },
  {
    match: /\b(framework|panel|standing offer|idiq)\b/i,
    chip: { label: 'Framework', tone: 'accent', title: 'Framework / standing offer' },
  },
];

export function typeChip(rawType: string | null | undefined): Chip | null {
  if (!rawType) return null;
  const match = TYPE_CHIPS.find((entry) => entry.match.test(rawType));
  if (match) return match.chip;
  // Fallback: render the raw type as a neutral chip so unmapped values are
  // still visible to the user.
  return { label: rawType.length > 20 ? `${rawType.slice(0, 18)}…` : rawType, tone: 'neutral' };
}

// -- Funding source chips ----------------------------------------------------

/**
 * Funding chip is heuristically derived. Procur hasn't structured a
 * `fundingSource` column yet; this scans the description / agency name for
 * MDB / donor markers. Move to a real column once the AI pipeline starts
 * extracting it.
 */
const MDB_PATTERNS =
  /\b(world bank|wb|caribbean development bank|cdb|inter-american development bank|idb|african development bank|afdb|asian development bank|adb|imf|usaid|undp|eu funded|ec funded)\b/i;

export function fundingChip(text: string | null | undefined): Chip | null {
  if (!text) return null;
  if (MDB_PATTERNS.test(text)) {
    return { label: 'MDB-funded', tone: 'accent', title: 'Multilateral / development bank financing' };
  }
  return null;
}

// -- Buyer / preference chips ------------------------------------------------

/**
 * Buyer-side preference flags. Translated from the various market vocabularies:
 *   - US: "Small Business", "8(a)"           → "Small Business"
 *   - Caribbean: "local preference", "CARIFORUM" → "Local Preference"
 *   - LatAm: "MIPYME", "preferencia nacional"   → "MSME" / "Local Preference"
 *   - Africa: "indigenous content"               → "Local Preference"
 */
const PREFERENCE_PATTERNS: Array<{ match: RegExp; chip: Chip }> = [
  {
    match: /\b(small business|8\(a\)|wosb|sdvosb|hubzone)\b/i,
    chip: { label: 'Small Business', tone: 'info' },
  },
  {
    match: /\b(local preference|preferencia nacional|cariforum|indigenous content|local content)\b/i,
    chip: { label: 'Local Preference', tone: 'info' },
  },
  {
    match: /\b(mipyme|sme|msme|micro|small.{0,5}medium enterprise)\b/i,
    chip: { label: 'MSME', tone: 'info' },
  },
  {
    match: /\b(joint venture|jv eligible|consortium)\b/i,
    chip: { label: 'JV Eligible', tone: 'accent' },
  },
];

export function preferenceChips(text: string | null | undefined): Chip[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const { match, chip } of PREFERENCE_PATTERNS) {
    if (match.test(text) && !seen.has(chip.label)) {
      seen.add(chip.label);
      out.push(chip);
    }
  }
  return out;
}

// -- Match score chip --------------------------------------------------------

/**
 * Derived from pWin (0..1). Renders as "85% match" with a tone that scales:
 *   ≥ 0.75 → success
 *   ≥ 0.50 → info
 *   ≥ 0.25 → warning
 *   else   → neutral
 */
export function matchChip(pWin: number | null): Chip | null {
  if (pWin == null) return null;
  const pct = Math.round(pWin * 100);
  let tone: ChipTone = 'neutral';
  if (pWin >= P_WIN_BANDS.high) tone = 'success';
  else if (pWin >= P_WIN_BANDS.medium) tone = 'info';
  else if (pWin >= P_WIN_BANDS.low) tone = 'warning';
  return { label: `${pct}% match`, tone, title: 'Win probability (P(Win))' };
}
