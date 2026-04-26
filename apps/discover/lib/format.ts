const SYMBOLS: Record<string, string> = {
  USD: '$',
  JMD: 'J$',
  GYD: 'G$',
  TTD: 'TT$',
  BBD: 'Bds$',
  BSD: 'B$',
  DOP: 'RD$',
  XCD: 'EC$',
  COP: 'COL$',
  PEN: 'S/',
  KES: 'KSh',
  GHS: 'GH₵',
  RWF: 'RF',
  ZAR: 'R',
  EUR: '€',
  GBP: '£',
};

export function formatMoney(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount == null) return null;
  const n = typeof amount === 'string' ? Number.parseFloat(amount) : amount;
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = (currency ?? 'USD').toUpperCase();
  const symbol = SYMBOLS[code] ?? `${code} `;

  const digits = n >= 1_000_000 ? 1 : 0;
  const formatted =
    n >= 1_000_000_000
      ? `${(n / 1_000_000_000).toFixed(digits)}B`
      : n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(digits)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(0)}K`
          : n.toFixed(0);

  return `${symbol}${formatted}`;
}

/**
 * Humanized "time until X" for a future date, or "closed" for past dates.
 * Server-safe (no tz tricks; uses UTC for stability).
 */
export function timeUntil(target: Date | null | undefined, now: Date = new Date()): string {
  // Guard against Invalid Date — when serialization or upstream parsing
  // produces a Date object whose getTime() is NaN, the rest of the
  // math cascades into "NaN months" rendered to users. Treat as null.
  if (!target || Number.isNaN(target.getTime())) return '';
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 'closed';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} weeks`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * Resolve the user's preferred display language from a request's
 * Accept-Language header. We key on the primary subtag (en, es, pt,
 * fr, …) — region variants (en-US, es-CL) collapse to the base. Defaults
 * to 'en' for missing/empty headers.
 */
export function preferredLanguage(acceptLanguage: string | null | undefined): string {
  if (!acceptLanguage) return 'en';
  const first = acceptLanguage
    .split(',')
    .map((part) => part.trim().split(';')[0]?.toLowerCase())
    .find((tag) => tag && tag.length > 0);
  if (!first) return 'en';
  return first.split('-')[0] ?? 'en';
}

type TranslationField = 'title' | 'description' | 'summary';
type TranslationsByLang = Record<
  string,
  { title?: string; description?: string; summary?: string } | undefined
> | null | undefined;

/**
 * Pick the field to display given the row's source language, the user's
 * preferred language, and any pre-computed translations stored on the row.
 *
 * - User language matches source → original.
 * - Translation for user language exists → translated value.
 * - Otherwise → original (no silent blanks).
 */
export function pickTranslated(
  field: TranslationField,
  original: string | null | undefined,
  sourceLanguage: string | null | undefined,
  translations: TranslationsByLang,
  userLanguage: string,
): string | null {
  const src = (sourceLanguage ?? 'en').toLowerCase();
  if (src === userLanguage) return original ?? null;
  const translated = translations?.[userLanguage]?.[field];
  if (translated && translated.trim().length > 0) return translated;
  return original ?? null;
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
