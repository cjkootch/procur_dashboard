import { requireCompany } from '@procur/auth';
import { listContracts } from '../../../../lib/contract-queries';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Contract inventory CSV export. Mirrors the columns rendered in the
 * /contract table view, plus IDs + computed compliance state so the
 * exported sheet is the same source of truth as the UI.
 *
 * Honors the same `?q=`, `?tier=`, `?status=` filters as the page so
 * the download matches what the user has on screen — without that,
 * search-and-export silently widened to every contract.
 */
export async function GET(req: Request): Promise<Response> {
  const { company } = await requireCompany();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const tier = url.searchParams.get('tier');
  const status = url.searchParams.get('status');

  const all = await listContracts(company.id);
  const rows = all.filter((r) => {
    if (tier && tier !== 'all' && r.tier !== tier) return false;
    if (status && status !== 'all' && r.status !== status) return false;
    if (q.length > 0) {
      const haystack = [
        r.awardTitle,
        r.awardingAgency,
        r.contractNumber,
        r.parentContractNumber,
        r.taskOrderNumber,
        r.subcontractNumber,
      ]
        .filter(Boolean)
        .join('  ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const headers = [
    'Contract ID',
    'Award title',
    'Tier',
    'Status',
    'Compliance',
    'Contract #',
    'Parent contract #',
    'Task order #',
    'Subcontract #',
    'Awarding agency',
    'Start date',
    'End date',
    'Total value',
    'Currency',
    'Total value (USD)',
    'Obligations total',
    'Obligations open',
    'Obligations overdue',
    'Updated at',
  ];

  const csvRows = rows.map((r) => [
    r.id,
    r.awardTitle,
    r.tier,
    r.status,
    r.compliance,
    r.contractNumber ?? '',
    r.parentContractNumber ?? '',
    r.taskOrderNumber ?? '',
    r.subcontractNumber ?? '',
    r.awardingAgency ?? '',
    r.startDate ?? '',
    r.endDate ?? '',
    r.totalValue ?? '',
    r.currency ?? '',
    r.totalValueUsd ?? '',
    r.obligationCount,
    r.openObligationCount,
    r.overdueObligationCount,
    r.updatedAt.toISOString(),
  ]);

  const csv = toCsv(headers, csvRows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-contracts-${today}.csv`, csv);
}
