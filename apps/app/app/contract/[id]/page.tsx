import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db, pastPerformance } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { getContractById } from '../../../lib/contract-queries';
import {
  listClinsForContract,
  listModificationsForContract,
  listTaskAreasForContract,
  summarizeClins,
  summarizeModifications,
} from '../../../lib/contract-extras-queries';
import { ContractHero } from '../components/contract-hero';
import { ContractTabNav, isTabKey, type TabKey } from '../components/tab-nav';
import { OverviewTab } from '../components/overview-tab';
import { ObligationsTab } from '../components/obligations-tab';
import { ModificationsTab } from '../components/modifications-tab';
import { ClinsTab } from '../components/clins-tab';
import { TaskAreasTab } from '../components/task-areas-tab';
import { DocumentsTab } from '../components/documents-tab';
import { PastPerformanceTab } from '../components/past-performance-tab';
import type { ComplianceState } from '../../../lib/contract-queries';

export const dynamic = 'force-dynamic';

export default async function ContractDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';

  const { company } = await requireCompany();
  const contract = await getContractById(company.id, id);
  if (!contract) notFound();

  // Always load counts for the tab nav badges (cheap pursuit-scoped queries).
  const [modifications, clins, taskAreas] = await Promise.all([
    listModificationsForContract(id),
    listClinsForContract(id),
    listTaskAreasForContract(id),
  ]);

  const modificationsSummary = summarizeModifications(modifications);
  const clinsSummary = summarizeClins(clins);

  // Find an existing past-performance entry generated from this contract so
  // we can show a deep-link instead of the generate CTA on the PP tab.
  const existingPP = await db.query.pastPerformance.findFirst({
    where: and(
      eq(pastPerformance.companyId, company.id),
      eq(pastPerformance.projectName, contract.awardTitle),
    ),
    columns: { id: true },
  });

  const obligations = contract.obligations ?? [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const openCount = obligations.filter((o) => o.status !== 'completed').length;
  const overdueCount = obligations.filter(
    (o) => o.status !== 'completed' && o.dueDate != null && o.dueDate < todayIso,
  ).length;
  const compliance: ComplianceState = deriveCompliance(
    contract.status,
    obligations.length,
    overdueCount,
    openCount,
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/contract" className="hover:underline">
          Contract
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">{contract.awardTitle}</span>
      </nav>

      <header className="mb-4 flex items-start justify-between gap-4">
        <ContractHero contract={contract} compliance={compliance} />
        <div className="flex shrink-0 flex-col items-end gap-2 text-xs">
          {contract.pursuitId && (
            <Link href={`/capture/pursuits/${contract.pursuitId}`} className="underline">
              Pursuit details →
            </Link>
          )}
        </div>
      </header>

      <ContractTabNav
        active={tab}
        contractId={id}
        obligationCount={obligations.length}
        modificationCount={modifications.length}
        clinCount={clins.length}
        taskAreaCount={taskAreas.length}
      />

      <div className="mt-4">
        {tab === 'overview' && <OverviewTab contract={contract} />}
        {tab === 'modifications' && (
          <ModificationsTab
            contractId={id}
            modifications={modifications}
            summary={modificationsSummary}
            currency={contract.currency}
          />
        )}
        {tab === 'clins' && (
          <ClinsTab
            contractId={id}
            clins={clins}
            summary={clinsSummary}
            currency={contract.currency}
          />
        )}
        {tab === 'task-areas' && <TaskAreasTab contractId={id} taskAreas={taskAreas} />}
        {tab === 'obligations' && <ObligationsTab contract={contract} />}
        {tab === 'documents' && <DocumentsTab contract={contract} />}
        {tab === 'past-performance' && (
          <PastPerformanceTab
            contractId={contract.id}
            existingPastPerformanceId={existingPP?.id ?? null}
          />
        )}
      </div>
    </div>
  );
}

// Mirror of lib/contract-queries.computeCompliance so the detail page derives
// the same chip state as the inventory list. Keep in sync with that helper.
function deriveCompliance(
  status: string,
  obligationCount: number,
  overdueCount: number,
  openCount: number,
): ComplianceState {
  if (status === 'completed' || status === 'terminated') return 'finalized';
  if (obligationCount === 0) return 'unconfigured';
  if (overdueCount > 0) return 'overdue';
  if (openCount > 0) return 'attention';
  return 'compliant';
}
