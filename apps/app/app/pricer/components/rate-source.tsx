import type { LaborRateSource } from '@procur/db';
import { chipClass } from '../../../lib/chips';

export const RATE_SOURCE_LABEL: Record<LaborRateSource, string> = {
  manual: 'Manual',
  published_rate_card: 'Rate card',
  collective_agreement: 'CBA',
  prior_contract: 'Prior contract',
  multilateral_rate_schedule: 'MDB schedule',
  other: 'Other',
};

const TONE: Record<LaborRateSource, Parameters<typeof chipClass>[0]> = {
  manual: 'neutral',
  published_rate_card: 'info',
  collective_agreement: 'accent',
  prior_contract: 'info',
  multilateral_rate_schedule: 'accent',
  other: 'neutral',
};

const TOOLTIP: Record<LaborRateSource, string> = {
  manual: 'User-entered. No reference document.',
  published_rate_card: 'Published government rate card (e.g. GSA Schedule).',
  collective_agreement: 'Collective bargaining / union agreement.',
  prior_contract: 'Rate carried from a prior similar contract.',
  multilateral_rate_schedule:
    'Rate schedule from a multilateral development bank (CDB / IDB / World Bank / AfDB).',
  other: 'Other — see reference for detail.',
};

/**
 * Compact chip for display in labor-category rows. Nullable input
 * renders as the neutral "Manual" fallback — matches the schema
 * comment that existing rows default to manual in app code.
 */
export function RateSourceChip({
  source,
  reference,
}: {
  source: LaborRateSource | null;
  reference: string | null;
}) {
  const effective: LaborRateSource = source ?? 'manual';
  const label = RATE_SOURCE_LABEL[effective];
  const tone = TONE[effective];
  const title = reference
    ? `${TOOLTIP[effective]}\nRef: ${reference}`
    : TOOLTIP[effective];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chipClass(tone)}`}
    >
      {label}
      {reference && <span className="opacity-70">· {truncate(reference, 18)}</span>}
    </span>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
