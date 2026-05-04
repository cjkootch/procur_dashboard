'use client';

/**
 * Visual renderer for crude-grade detail — used both by:
 *   - the `/crudes/[slug]` page (server-renders the data, this
 *     component takes it as a prop and renders), and
 *   - the chat assistant when `view_crude_grade_detail` returns a
 *     `kind: 'crude_grade_detail'` payload (Chat.tsx dispatches via
 *     isCrudeGradeDetailOutput).
 *
 * Shape mirrors `CrudeGradeDetailResult` from @procur/catalog.
 */
import { type ReactNode } from 'react';
import type { CrudeGradeDetailResult } from '@procur/catalog';

export type CrudeGradeDetailOutput = CrudeGradeDetailResult;

export function isCrudeGradeDetailOutput(
  output: unknown,
): output is CrudeGradeDetailOutput {
  if (!output || typeof output !== 'object') return false;
  const o = output as Record<string, unknown>;
  return (
    o.kind === 'crude_grade_detail' &&
    typeof o.grade === 'object' &&
    o.grade !== null &&
    Array.isArray(o.assays) &&
    Array.isArray(o.compatibleRefineries)
  );
}

export function CrudeGradeCard({
  output,
}: {
  output: CrudeGradeDetailOutput;
}): ReactNode {
  const { grade, assays, compatibleRefineries } = output;
  const freshestAssay = assays[0] ?? null;

  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <Header grade={grade} />
      <PropertyStrip grade={grade} freshest={freshestAssay} />
      {freshestAssay && freshestAssay.cuts.length > 0 ? (
        <TbpCutChart cuts={freshestAssay.cuts} sourceLabel={producerLabel(freshestAssay.source)} />
      ) : null}
      {assays.length > 1 ? <ProducerComparison assays={assays} /> : null}
      {compatibleRefineries.length > 0 ? (
        <CompatibleRefineries refineries={compatibleRefineries} />
      ) : null}
      {grade.notes ? (
        <p className="text-xs text-[color:var(--color-muted-foreground)] leading-relaxed">
          {grade.notes}
        </p>
      ) : null}
    </div>
  );
}

function Header({ grade }: { grade: CrudeGradeDetailOutput['grade'] }): ReactNode {
  const markerLine =
    grade.isMarker
      ? <span className="rounded-full bg-[color:var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-accent)]">marker</span>
      : grade.markerSlug
        ? <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
            vs <span className="font-medium">{grade.markerSlug.toUpperCase()}</span>
            {grade.differentialUsdPerBbl != null
              ? ` ${grade.differentialUsdPerBbl >= 0 ? '+' : ''}$${grade.differentialUsdPerBbl.toFixed(2)}/bbl`
              : ''}
          </span>
        : null;

  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-base font-semibold leading-tight">{grade.name}</h3>
        <div className="flex items-center gap-2 text-[11px] text-[color:var(--color-muted-foreground)]">
          {grade.originCountry ? <span>{grade.originCountry}</span> : null}
          {grade.region ? <span>· {prettyRegion(grade.region)}</span> : null}
          {grade.characterization ? <span>· {grade.characterization}</span> : null}
        </div>
      </div>
      <div>{markerLine}</div>
    </div>
  );
}

/**
 * Headline whole-crude properties. Falls back to the freshest assay's
 * value when the curated grade row doesn't carry that field. Always
 * cites the source on hover so the operator knows whether they're
 * reading curated or producer-published data.
 */
function PropertyStrip({
  grade,
  freshest,
}: {
  grade: CrudeGradeDetailOutput['grade'];
  freshest: CrudeGradeDetailOutput['assays'][number] | null;
}): ReactNode {
  const items: Array<{ label: string; value: string; suffix?: string }> = [];
  const api = grade.apiGravity ?? freshest?.apiGravity ?? null;
  if (api != null) items.push({ label: 'API', value: api.toFixed(1), suffix: '°' });
  const sulfur = grade.sulfurPct ?? freshest?.sulphurWtPct ?? null;
  if (sulfur != null) items.push({ label: 'Sulfur', value: sulfur.toFixed(2), suffix: '% wt' });
  const tan = grade.tan ?? freshest?.acidityMgKohG ?? null;
  if (tan != null) items.push({ label: 'TAN', value: tan.toFixed(2), suffix: ' mgKOH/g' });
  if (freshest?.densityKgL != null) {
    items.push({ label: 'Density', value: freshest.densityKgL.toFixed(3), suffix: ' kg/L' });
  }
  if (freshest?.pourPointC != null) {
    items.push({ label: 'Pour pt', value: freshest.pourPointC.toFixed(0), suffix: '°C' });
  }
  if (freshest?.vanadiumMgKg != null) {
    items.push({ label: 'V', value: freshest.vanadiumMgKg.toFixed(1), suffix: ' ppm' });
  }
  if (freshest?.nickelMgKg != null) {
    items.push({ label: 'Ni', value: freshest.nickelMgKg.toFixed(1), suffix: ' ppm' });
  }
  if (freshest?.viscosityCst50c != null) {
    items.push({
      label: 'Visc 50°',
      value: freshest.viscosityCst50c.toFixed(1),
      suffix: ' cSt',
    });
  }
  if (items.length === 0) {
    return (
      <div className="text-xs text-[color:var(--color-muted-foreground)]">
        No characterized properties.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-2 py-1.5"
        >
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {it.label}
          </div>
          <div className="text-sm font-medium leading-tight">
            {it.value}
            <span className="text-[10px] text-[color:var(--color-muted-foreground)]">{it.suffix}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Horizontal stacked bar chart of TBP cut yields, light → heavy.
 * The first cut is typically the IBP-FBP "whole crude" placeholder
 * with no yield value — drop those before laying out so the chart
 * shows real distillation cuts only.
 */
function TbpCutChart({
  cuts,
  sourceLabel,
}: {
  cuts: CrudeGradeDetailOutput['assays'][number]['cuts'];
  sourceLabel: string;
}): ReactNode {
  const drawn = cuts.filter((c) => c.yieldWtPct != null && c.yieldWtPct > 0);
  if (drawn.length === 0) {
    return null;
  }
  const total = drawn.reduce((acc, c) => acc + (c.yieldWtPct ?? 0), 0);
  // Bar width: one row per cut, fixed height 14px, full-width.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-[11px] text-[color:var(--color-muted-foreground)]">
        <span className="font-medium uppercase tracking-wide">TBP cut yields (% wt)</span>
        <span>{sourceLabel}</span>
      </div>
      <div className="flex flex-col gap-1">
        {drawn.map((cut) => {
          const widthPct = total > 0 ? ((cut.yieldWtPct ?? 0) / total) * 100 : 0;
          return (
            <div key={cut.cutOrder} className="grid grid-cols-[8rem,1fr,3rem] items-center gap-2">
              <div
                className="truncate text-[11px] text-[color:var(--color-muted-foreground)]"
                title={
                  cut.startTempC != null && cut.endTempC != null
                    ? `${cut.startTempC.toFixed(0)}-${cut.endTempC.toFixed(0)}°C`
                    : cut.cutLabel
                }
              >
                {prettyCutLabel(cut)}
              </div>
              <div className="h-3 rounded-full bg-[color:var(--color-muted)]/30">
                <div
                  className="h-full rounded-full bg-[color:var(--color-accent)]/70"
                  style={{ width: `${widthPct.toFixed(1)}%` }}
                />
              </div>
              <div className="text-right text-[11px] tabular-nums">
                {cut.yieldWtPct?.toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProducerComparison({
  assays,
}: {
  assays: CrudeGradeDetailOutput['assays'];
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Producer assays ({assays.length})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[color:var(--color-muted-foreground)]">
              <th className="px-2 py-1 font-normal">Producer</th>
              <th className="px-2 py-1 font-normal">Vintage</th>
              <th className="px-2 py-1 text-right font-normal">API</th>
              <th className="px-2 py-1 text-right font-normal">Sulfur %</th>
              <th className="px-2 py-1 text-right font-normal">TAN</th>
              <th className="px-2 py-1 text-right font-normal">V/Ni ppm</th>
              <th className="px-2 py-1 text-right font-normal">Pour °C</th>
            </tr>
          </thead>
          <tbody>
            {assays.map((a) => (
              <tr
                key={`${a.source}-${a.reference}`}
                className="border-t border-[color:var(--color-border)] tabular-nums"
              >
                <td className="px-2 py-1 font-medium not-tabular-nums">{producerLabel(a.source)}</td>
                <td className="px-2 py-1 not-tabular-nums text-[color:var(--color-muted-foreground)]">
                  {a.assayDate ?? '—'}
                </td>
                <td className="px-2 py-1 text-right">{a.apiGravity?.toFixed(1) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{a.sulphurWtPct?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{a.acidityMgKohG?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">
                  {a.vanadiumMgKg != null || a.nickelMgKg != null
                    ? `${a.vanadiumMgKg?.toFixed(0) ?? '—'} / ${a.nickelMgKg?.toFixed(0) ?? '—'}`
                    : '—'}
                </td>
                <td className="px-2 py-1 text-right">{a.pourPointC?.toFixed(0) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompatibleRefineries({
  refineries,
}: {
  refineries: CrudeGradeDetailOutput['compatibleRefineries'];
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        Compatible refineries ({refineries.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {refineries.slice(0, 12).map((r) => (
          <a
            key={r.slug}
            href={`/entities/${r.slug}`}
            className="rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-2 py-0.5 text-[11px] hover:bg-[color:var(--color-muted)]/40"
            title={
              r.complexityIndex != null
                ? `NCI ${r.complexityIndex.toFixed(1)}${r.capacityBpd ? ` · ${(r.capacityBpd / 1000).toFixed(0)} kbd` : ''}`
                : undefined
            }
          >
            {r.name}
            <span className="ml-1 text-[color:var(--color-muted-foreground)]">{r.country}</span>
          </a>
        ))}
        {refineries.length > 12 ? (
          <span className="self-center text-[11px] text-[color:var(--color-muted-foreground)]">
            +{refineries.length - 12} more
          </span>
        ) : null}
      </div>
    </div>
  );
}

function producerLabel(source: string): string {
  switch (source) {
    case 'exxonmobil':
      return 'ExxonMobil';
    case 'bp':
      return 'BP';
    case 'equinor':
      return 'Equinor';
    case 'totalenergies':
      return 'TotalEnergies';
    case 'qarat':
      return 'Qarat';
    default:
      return source;
  }
}

function prettyRegion(slug: string): string {
  return slug
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function prettyCutLabel(cut: {
  cutLabel: string;
  startTempC: number | null;
  endTempC: number | null;
}): string {
  // Synthesize a friendly label from the temp range when the
  // producer-published label is just numeric (e.g. "150-230").
  if (cut.cutLabel && /[A-Za-z]/.test(cut.cutLabel)) return cut.cutLabel;
  if (cut.startTempC != null && cut.endTempC != null) {
    const lo = cut.startTempC;
    const hi = cut.endTempC;
    return `${lo.toFixed(0)}-${hi.toFixed(0)}°C`;
  }
  return cut.cutLabel || '?';
}
