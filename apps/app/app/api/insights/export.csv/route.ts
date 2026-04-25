import { requireCompany } from '@procur/auth';
import { getInsights } from '../../../../lib/insights-queries';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Insights snapshot CSV export. The /insights page renders three
 * tabular sections — stage breakdown, top jurisdictions, top
 * categories — alongside top-line counts. Stitching them into one
 * CSV would lose the section structure, so we emit a long-form
 * "section,field,value" file: each cell is one row, prefixed by the
 * section it came from.
 *
 * Useful for exec reporting + month-over-month comparison; the
 * shape pivots cleanly in Excel.
 */
export async function GET(): Promise<Response> {
  const { company } = await requireCompany();
  const i = await getInsights(company.id);

  const headers = ['Section', 'Field', 'Value'];
  const rows: Array<[string, string, string | number]> = [];

  // Top-line counters
  rows.push(['Summary', 'Total pursuits', i.totalPursuits]);
  rows.push(['Summary', 'Active pursuits', i.activePursuits]);
  rows.push(['Summary', 'Awarded', i.awardedCount]);
  rows.push(['Summary', 'Lost', i.lostCount]);
  rows.push(['Summary', 'Win rate', `${(i.winRate * 100).toFixed(1)}%`]);
  rows.push(['Summary', 'Pipeline value (USD)', Math.round(i.pipelineValueUsd)]);
  rows.push([
    'Summary',
    'Weighted pipeline (USD)',
    Math.round(i.weightedPipelineUsd),
  ]);
  rows.push(['Summary', 'Won value (USD)', Math.round(i.wonValueUsd)]);
  rows.push(['Summary', 'Active contracts', i.contractCount]);
  rows.push([
    'Summary',
    'Active contract value (USD)',
    Math.round(i.activeContractValueUsd),
  ]);
  rows.push(['Summary', 'Past performance entries', i.pastPerformanceCount]);

  // Stage breakdown — one row per stage, multiple values
  for (const s of i.stageBreakdown) {
    rows.push([`Stage: ${s.label}`, 'Pursuits', s.count]);
    rows.push([`Stage: ${s.label}`, 'Total value (USD)', Math.round(s.totalValueUsd)]);
    rows.push([
      `Stage: ${s.label}`,
      'Weighted value (USD)',
      Math.round(s.weightedValueUsd),
    ]);
  }

  // Top jurisdictions
  for (const j of i.topJurisdictions) {
    rows.push([`Jurisdiction: ${j.name}`, 'Country', j.countryCode]);
    rows.push([`Jurisdiction: ${j.name}`, 'Pursuits', j.pursuitCount]);
    rows.push([`Jurisdiction: ${j.name}`, 'Won', j.wonCount]);
  }

  // Top categories
  for (const c of i.topCategories) {
    rows.push([`Category: ${c.category}`, 'Pursuits', c.pursuitCount]);
    rows.push([`Category: ${c.category}`, 'Won', c.wonCount]);
  }

  const csv = toCsv(headers, rows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-insights-${today}.csv`, csv);
}
