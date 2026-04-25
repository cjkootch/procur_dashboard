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
 * The UI links here unconditionally — the route was missing before
 * this commit and 404'd. Now it returns a single .csv with every
 * contract for the current tenant; if the user wants a filtered
 * subset, they can filter in the spreadsheet (the column shape
 * supports it).
 */
export async function GET(): Promise<Response> {
  const { company } = await requireCompany();
  const rows = await listContracts(company.id);

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
