import type { OpportunityRowData } from '@procur/email-templates';
import type { MatchedOpportunity } from './matching';

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

function formatMoney(amount: string | null, currency: string | null): string | null {
  if (!amount) return null;
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const code = (currency ?? 'USD').toUpperCase();
  const sym = SYMBOLS[code] ?? `${code} `;
  if (n >= 1_000_000_000) return `${sym}${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(0)}K`;
  return `${sym}${n.toFixed(0)}`;
}

function formatDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function toEmailRow(
  op: MatchedOpportunity,
  discoverUrl: string,
): OpportunityRowData {
  return {
    id: op.id,
    title: op.title,
    url: `${discoverUrl}/opportunities/${op.slug}`,
    agency: op.agency,
    jurisdiction: op.jurisdictionName,
    value: formatMoney(op.valueEstimate, op.currency),
    deadline: formatDate(op.deadlineAt),
  };
}

export function sumUsd(ops: MatchedOpportunity[]): string | null {
  let total = 0;
  let any = false;
  for (const op of ops) {
    if (op.valueEstimateUsd) {
      const n = Number.parseFloat(op.valueEstimateUsd);
      if (Number.isFinite(n)) {
        total += n;
        any = true;
      }
    }
  }
  if (!any) return null;
  return formatMoney(String(total), 'USD');
}
