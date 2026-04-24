import ExcelJS from 'exceljs';
import { eq, and } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  laborCategories,
  opportunities,
  pricingModels,
  pursuits,
} from '@procur/db';
import { requireCompany } from '@procur/auth';
import { summarize } from '../../../../../lib/pricer-queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pursuitId: string }> },
): Promise<Response> {
  const { pursuitId } = await params;
  const { company } = await requireCompany();

  const [row] = await db
    .select({
      pursuitId: pursuits.id,
      oppTitle: opportunities.title,
      oppReferenceNumber: opportunities.referenceNumber,
      jurisdictionName: jurisdictions.name,
      agencyName: agencies.name,
      deadlineAt: opportunities.deadlineAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)))
    .limit(1);
  if (!row) return new Response('not found', { status: 404 });

  const pricingModel = await db.query.pricingModels.findFirst({
    where: eq(pricingModels.pursuitId, pursuitId),
  });
  if (!pricingModel) return new Response('no pricing model', { status: 404 });

  const lcs = await db
    .select()
    .from(laborCategories)
    .where(eq(laborCategories.pricingModelId, pricingModel.id));

  const summary = summarize(pricingModel, lcs);
  const currency = pricingModel.currency ?? 'USD';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Procur';
  wb.created = new Date();

  // Sheet 1: Summary
  const s1 = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF111111' } } });
  s1.columns = [
    { key: 'label', width: 30 },
    { key: 'value', width: 40 },
  ];
  s1.addRows([
    ['Procur Pricer export', ''],
    ['Tender', row.oppTitle],
    ['Reference', row.oppReferenceNumber ?? ''],
    ['Agency', row.agencyName ?? row.jurisdictionName],
    ['Deadline', row.deadlineAt ? row.deadlineAt.toISOString().slice(0, 10) : ''],
    ['', ''],
    ['Pricing strategy', pricingModel.pricingStrategy],
    ['Currency', currency],
    ['FX to USD', pricingModel.fxRateToUsd ?? '—'],
    ['Base period (months)', pricingModel.basePeriodMonths ?? ''],
    ['Option years', pricingModel.optionYears ?? 0],
    ['Total period (years)', summary.periodYears],
    ['Escalation %/yr', pricingModel.escalationRate ?? '0'],
    ['', ''],
    ['Fringe rate %', pricingModel.fringeRate ?? '0'],
    ['Overhead rate %', pricingModel.overheadRate ?? '0'],
    ['G&A rate %', pricingModel.gaRate ?? '0'],
    ['Wrap rate (multiplier)', summary.wrapRate],
    ['', ''],
    ['Target fee %', pricingModel.targetFeePct ?? '0'],
    ['Total labor cost', summary.totalLaborCost],
    ['Target fee', summary.targetFee],
    ['TOTAL TARGET VALUE', summary.totalValue],
    ['Total value (USD equiv.)', summary.totalValueUsd ?? '—'],
    ['', ''],
    ['Government estimate', pricingModel.governmentEstimate ?? '—'],
    ['Ceiling value', pricingModel.ceilingValue ?? '—'],
  ]);
  s1.getColumn('A').font = { bold: true };
  s1.getRow(1).font = { bold: true, size: 14 };

  // Sheet 2: Labor Categories
  const s2 = wb.addWorksheet('Labor Categories');
  s2.columns = [
    { header: 'Title', key: 'title', width: 32 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Direct rate', key: 'direct', width: 14 },
    { header: 'Loaded rate', key: 'loaded', width: 14 },
    { header: 'Hours/yr', key: 'hours', width: 10 },
    { header: 'Total cost', key: 'total', width: 16 },
  ];
  s2.getRow(1).font = { bold: true };
  s2.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEEEEE' },
  };

  for (const calc of summary.laborCategories) {
    s2.addRow({
      title: calc.title,
      type: lcs.find((l) => l.id === calc.id)?.type ?? '',
      direct: calc.directRate,
      loaded: calc.loadedRate,
      hours: calc.hoursPerYear,
      total: calc.totalCost,
    });
  }
  s2.addRow([]);
  const totalRow = s2.addRow(['Total labor cost', '', '', '', '', summary.totalLaborCost]);
  totalRow.font = { bold: true };

  // Sheet 3: Yearly Breakdown
  if (summary.laborCategories.length > 0) {
    const s3 = wb.addWorksheet('Yearly Breakdown');
    const headerCols: Partial<ExcelJS.Column>[] = [
      { header: 'Category', key: 'title', width: 32 },
    ];
    for (let y = 1; y <= summary.periodYears; y += 1) {
      headerCols.push({ header: `Yr ${y} rate`, key: `r${y}`, width: 12 });
      headerCols.push({ header: `Yr ${y} cost`, key: `c${y}`, width: 14 });
    }
    headerCols.push({ header: 'Total', key: 'total', width: 16 });
    s3.columns = headerCols;
    s3.getRow(1).font = { bold: true };
    s3.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEEEEEE' },
    };
    for (const calc of summary.laborCategories) {
      const rowVals: Record<string, unknown> = { title: calc.title, total: calc.totalCost };
      for (const yr of calc.yearlyBreakdown) {
        rowVals[`r${yr.year}`] = yr.rate;
        rowVals[`c${yr.year}`] = yr.cost;
      }
      s3.addRow(rowVals);
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const safe = row.oppTitle
    .replace(/[^a-z0-9\- ]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="procur-pricer-${safe || 'model'}.xlsx"`,
      'cache-control': 'no-store',
    },
  });
}
