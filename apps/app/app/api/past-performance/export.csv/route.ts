import { eq } from 'drizzle-orm';
import { db, pastPerformance } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { company } = await requireCompany();

  const rows = await db
    .select()
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, company.id));

  const headers = [
    'Project',
    'Customer',
    'Customer type',
    'Period start',
    'Period end',
    'Total value',
    'Currency',
    'Scope',
    'Key accomplishments',
    'Challenges',
    'Outcomes',
    'Reference name',
    'Reference title',
    'Reference email',
    'Reference phone',
    'NAICS',
    'Categories',
    'Keywords',
  ];

  const csvRows = rows.map((r) => [
    r.projectName,
    r.customerName,
    r.customerType ?? '',
    r.periodStart ?? '',
    r.periodEnd ?? '',
    r.totalValue ?? '',
    r.currency ?? '',
    r.scopeDescription,
    (r.keyAccomplishments ?? []).join(' | '),
    r.challenges ?? '',
    r.outcomes ?? '',
    r.referenceName ?? '',
    r.referenceTitle ?? '',
    r.referenceEmail ?? '',
    r.referencePhone ?? '',
    (r.naicsCodes ?? []).join(' | '),
    (r.categories ?? []).join(' | '),
    (r.keywords ?? []).join(' | '),
  ]);

  const csv = toCsv(headers, csvRows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-past-performance-${today}.csv`, csv);
}
