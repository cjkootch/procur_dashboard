import type { ComplianceState } from '../../../lib/contract-queries';
import { chipClass, type ChipTone } from '../../../lib/chips';

const COMPLIANCE_LABEL: Record<ComplianceState, string> = {
  compliant: 'Compliant',
  attention: 'Attention',
  overdue: 'Overdue',
  finalized: 'Finalized',
  unconfigured: 'Unconfigured',
};

const COMPLIANCE_TONE: Record<ComplianceState, ChipTone> = {
  compliant: 'success',
  attention: 'warning',
  overdue: 'danger',
  finalized: 'neutral',
  unconfigured: 'neutral',
};

const COMPLIANCE_TITLE: Record<ComplianceState, string> = {
  compliant: 'All obligations on track',
  attention: 'Has open obligations — monitor upcoming deadlines',
  overdue: 'At least one obligation is past due',
  finalized: 'Contract has been completed or terminated',
  unconfigured: 'No obligations configured yet — add them on the detail page',
};

export function ComplianceChip({ state }: { state: ComplianceState }) {
  const tone = COMPLIANCE_TONE[state];
  const label = COMPLIANCE_LABEL[state];
  return (
    <span
      title={COMPLIANCE_TITLE[state]}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(tone)}`}
    >
      {state === 'compliant' && <span aria-hidden>✓</span>}
      {state === 'overdue' && <span aria-hidden>●</span>}
      {label}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  terminated: 'Terminated',
};

const STATUS_TONE: Record<string, ChipTone> = {
  active: 'info',
  completed: 'neutral',
  terminated: 'neutral',
};

export function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const label = STATUS_LABEL[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass(tone)}`}
    >
      {label}
    </span>
  );
}

const TIER_LABEL: Record<string, string> = {
  prime: 'Prime',
  subcontract: 'Subcontract',
  task_order: 'Task Order',
};

export function TierChip({ tier }: { tier: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chipClass('accent')}`}>
      {TIER_LABEL[tier] ?? tier}
    </span>
  );
}
