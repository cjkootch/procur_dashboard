import type { Contract } from '@procur/db';
import { formatDate, formatMoney } from '../../../lib/format';
import type { ComplianceState } from '../../../lib/contract-queries';
import { ComplianceChip, StatusChip, TierChip } from './chips';

/**
 * Contract detail hero — matches the GovDash multi-chip header strip.
 * Title + agency breadcrumb on top, then a wrap-friendly chip row with
 * Tier · Value · Period · Numbers · Compliance · Status.
 */
export function ContractHero({
  contract,
  compliance,
}: {
  contract: Contract;
  compliance: ComplianceState;
}) {
  const totalValue = formatMoney(contract.totalValue, contract.currency);
  const totalUsd =
    contract.currency !== 'USD' ? formatMoney(contract.totalValueUsd, 'USD') : null;
  const period =
    contract.startDate && contract.endDate
      ? `${formatDate(new Date(contract.startDate))} → ${formatDate(new Date(contract.endDate))}`
      : contract.startDate
        ? `From ${formatDate(new Date(contract.startDate))}`
        : null;

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">{contract.awardTitle}</h1>
      <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
        {contract.awardingAgency ?? '—'}
        {contract.contractNumber && (
          <>
            {' · '}
            <span className="font-mono">{contract.contractNumber}</span>
          </>
        )}
        {contract.primeContractor && <> · under {contract.primeContractor}</>}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TierChip tier={contract.tier} />
        {totalValue && (
          <Chip>
            <span className="font-semibold">{totalValue}</span>
            {totalUsd && (
              <span className="ml-1 text-[color:var(--color-muted-foreground)]">≈ {totalUsd}</span>
            )}
          </Chip>
        )}
        {period && <Chip>{period}</Chip>}
        {contract.parentContractNumber && (
          <Chip>
            <span className="text-[color:var(--color-muted-foreground)]">Parent:</span>{' '}
            <span className="font-mono">{contract.parentContractNumber}</span>
          </Chip>
        )}
        {contract.taskOrderNumber && (
          <Chip>
            <span className="text-[color:var(--color-muted-foreground)]">TO:</span>{' '}
            <span className="font-mono">{contract.taskOrderNumber}</span>
          </Chip>
        )}
        {contract.subcontractNumber && (
          <Chip>
            <span className="text-[color:var(--color-muted-foreground)]">Sub:</span>{' '}
            <span className="font-mono">{contract.subcontractNumber}</span>
          </Chip>
        )}
        <ComplianceChip state={compliance} />
        <StatusChip status={contract.status} />
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-[11px]">
      {children}
    </span>
  );
}
