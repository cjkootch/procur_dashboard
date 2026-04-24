import { eq } from 'drizzle-orm';
import { agencies, db, jurisdictions, opportunities, pursuits } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { company } = await requireCompany();

  const rows = await db
    .select({
      pursuitId: pursuits.id,
      stage: pursuits.stage,
      pWin: pursuits.pWin,
      weightedValue: pursuits.weightedValue,
      notes: pursuits.notes,
      createdAt: pursuits.createdAt,
      updatedAt: pursuits.updatedAt,
      opportunityTitle: opportunities.title,
      referenceNumber: opportunities.referenceNumber,
      jurisdiction: jurisdictions.name,
      country: jurisdictions.countryCode,
      agency: agencies.name,
      category: opportunities.category,
      valueEstimate: opportunities.valueEstimate,
      currency: opportunities.currency,
      valueEstimateUsd: opportunities.valueEstimateUsd,
      awardedAmount: opportunities.awardedAmount,
      deadlineAt: opportunities.deadlineAt,
      publishedAt: opportunities.publishedAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(pursuits.companyId, company.id));

  const headers = [
    'Pursuit ID',
    'Stage',
    'P(Win)',
    'Weighted value (USD)',
    'Opportunity',
    'Reference #',
    'Jurisdiction',
    'Country',
    'Agency',
    'Category',
    'Value',
    'Currency',
    'Value (USD)',
    'Awarded amount',
    'Deadline',
    'Published',
    'Pursuit created',
    'Pursuit updated',
    'Notes',
  ];

  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

  const csvRows = rows.map((r) => [
    r.pursuitId,
    r.stage,
    r.pWin ?? '',
    r.weightedValue ?? '',
    r.opportunityTitle,
    r.referenceNumber ?? '',
    r.jurisdiction,
    r.country,
    r.agency ?? '',
    r.category ?? '',
    r.valueEstimate ?? '',
    r.currency ?? '',
    r.valueEstimateUsd ?? '',
    r.awardedAmount ?? '',
    iso(r.deadlineAt),
    iso(r.publishedAt),
    iso(r.createdAt),
    iso(r.updatedAt),
    r.notes ?? '',
  ]);

  const csv = toCsv(headers, csvRows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-pipeline-${today}.csv`, csv);
}
