const SYMBOLS: Record<string, string> = {
  USD: '$',
  JMD: 'J$',
  GYD: 'G$',
  TTD: 'TT$',
  BBD: 'Bds$',
  DOP: 'RD$',
  XCD: 'EC$',
  COP: 'COL$',
  PEN: 'S/',
  KES: 'KSh',
  GHS: 'GH₵',
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
  const sym = SYMBOLS[code] ?? `${code} `;
  if (n >= 1_000_000_000) return `${sym}${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(0)}K`;
  return `${sym}${n.toFixed(0)}`;
}

export function timeUntil(target: Date | null | undefined, now: Date = new Date()): string {
  if (!target) return '';
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

export function formatDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function flagFor(countryCode: string | null | undefined): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  const base = 0x1f1e6;
  const code = countryCode.toUpperCase();
  const a = code.charCodeAt(0) - 0x41;
  const b = code.charCodeAt(1) - 0x41;
  if (a < 0 || a > 25 || b < 0 || b > 25) return '🏳️';
  return String.fromCodePoint(base + a, base + b);
}
