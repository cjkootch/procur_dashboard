import { eq } from 'drizzle-orm';
import { agencies, db, jurisdictions, opportunities, pursuits } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { csvResponse, toCsv } from '../../../../lib/csv';
import { STAGE_ORDER, type PursuitStageKey } from '../../../../lib/capture-queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isStage(v: string | null): v is PursuitStageKey {
  return Boolean(v) && STAGE_ORDER.includes(v as PursuitStageKey);
}

/**
 * Pursuits CSV export. Honors `?q=` and `?stage=` so the download
 * matches what the user filtered on /capture/pursuits — without it,
 * a search for "Trinidad" + Export silently downloaded every row,
 * with no obvious explanation for the count mismatch.
 *
 * Filter logic mirrors the page: substring across opportunity title,
 * agency, jurisdiction, reference number, and notes.
 */
export async function GET(req: Request): Promise<Response> {
  const { company } = await requireCompany();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const stageParam = url.searchParams.get('stage');
  const stage: PursuitStageKey | null = isStage(stageParam) ? stageParam : null;

  const allRows = await db
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
    // leftJoin: private uploaded opportunities have no jurisdiction —
    // inner-joining would silently drop them from the export.
    .leftJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(eq(pursuits.companyId, company.id));

  const rows = allRows.filter((r) => {
    if (stage && r.stage !== stage) return false;
    if (q.length > 0) {
      const haystack = [
        r.opportunityTitle,
        r.agency,
        r.jurisdiction,
        r.referenceNumber,
        r.notes,
      ]
        .filter(Boolean)
        .join('  ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

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
    r.jurisdiction ?? '',
    r.country ?? '',
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
