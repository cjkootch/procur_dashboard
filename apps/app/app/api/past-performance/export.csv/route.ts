import { eq } from 'drizzle-orm';
import { db, pastPerformance } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Past-performance CSV export. Honors `?q=` so the export matches the
 * search the user ran on the page (project / customer / customer-type
 * substring). Without that, an export after a search silently
 * downloaded every entry.
 */
export async function GET(req: Request): Promise<Response> {
  const { company } = await requireCompany();
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().toLowerCase();

  const allRows = await db
    .select()
    .from(pastPerformance)
    .where(eq(pastPerformance.companyId, company.id));

  const rows = q
    ? allRows.filter((r) => {
        const haystack = [r.projectName, r.customerName, r.customerType]
          .filter(Boolean)
          .join('  ')
          .toLowerCase();
        return haystack.includes(q);
      })
    : allRows;

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
