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
 *
 * Layout, top → bottom:
 *   1. Header — name + classification chip + origin/region/character
 *      + marker differential (signed, colored).
 *   2. Hero API + Sulfur scales — the two trader-facing punchlines,
 *      rendered as colored range bars with the grade's value plotted.
 *   3. Other property grid — density, pour point, TAN, V, Ni, etc.
 *   4. TBP cut yield chart — when structured cuts are available;
 *      otherwise a tight empty state.
 *   5. Producer assay comparison table — when ≥ 2 producers published
 *      the grade.
 *   6. Compatible refineries — chips sorted by NCI, NCI shown inline.
 *   7. Notes — analyst-curated free-form description.
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

  // Pull headline values — prefer curated grade row, fall back to
  // freshest assay value when absent.
  const apiGravity = grade.apiGravity ?? freshestAssay?.apiGravity ?? null;
  const sulfurPct = grade.sulfurPct ?? freshestAssay?.sulphurWtPct ?? null;
  const tan = grade.tan ?? freshestAssay?.acidityMgKohG ?? null;

  return (
    <div className="flex flex-col gap-5 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-sm">
      <Header grade={grade} apiGravity={apiGravity} sulfurPct={sulfurPct} />
      <HeroScales apiGravity={apiGravity} sulfurPct={sulfurPct} />
      <OtherProperties freshest={freshestAssay} tan={tan} />
      <CutSection assays={assays} />
      {assays.length > 1 ? <ProducerComparison assays={assays} /> : null}
      <CompatibleRefineries refineries={compatibleRefineries} />
      {grade.notes ? <NotesBlock notes={grade.notes} /> : null}
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────

function Header({
  grade,
  apiGravity,
  sulfurPct,
}: {
  grade: CrudeGradeDetailOutput['grade'];
  apiGravity: number | null;
  sulfurPct: number | null;
}): ReactNode {
  const classification = classifyGrade(apiGravity, sulfurPct);
  const diff = grade.differentialUsdPerBbl;
  const diffColor =
    diff == null
      ? 'var(--color-muted-foreground)'
      : diff > 0
        ? 'rgb(34, 139, 84)'
        : diff < 0
          ? 'rgb(190, 60, 60)'
          : 'var(--color-muted-foreground)';

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-2xl font-semibold leading-none tracking-tight">
            {grade.name}
          </h2>
          {grade.isMarker ? <MarkerPill /> : null}
          {classification ? <ClassificationPill kind={classification} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {grade.originCountry ? <span>{grade.originCountry}</span> : null}
          {grade.region ? <span>· {prettyRegion(grade.region)}</span> : null}
          {grade.characterization ? <span>· {grade.characterization}</span> : null}
        </div>
      </div>
      {grade.markerSlug && diff != null ? (
        <div className="flex flex-col items-end gap-0.5 text-right">
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            vs {grade.markerSlug.toUpperCase()}
          </div>
          <div className="text-base font-semibold tabular-nums" style={{ color: diffColor }}>
            {diff > 0 ? '+' : ''}${diff.toFixed(2)}
            <span className="ml-1 text-[11px] font-normal text-[color:var(--color-muted-foreground)]">
              /bbl
            </span>
          </div>
        </div>
      ) : grade.isMarker ? (
        <div className="flex flex-col items-end gap-0.5 text-right">
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Pricing benchmark
          </div>
          <div className="text-xs text-[color:var(--color-muted-foreground)]">
            Other grades quote vs this marker
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MarkerPill(): ReactNode {
  return (
    <span className="rounded-full bg-[color:var(--color-accent)]/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-accent)]">
      marker
    </span>
  );
}

type Classification =
  | 'condensate'
  | 'light-sweet'
  | 'light-sour'
  | 'medium-sweet'
  | 'medium-sour'
  | 'heavy-sweet'
  | 'heavy-sour';

function classifyGrade(api: number | null, sulfur: number | null): Classification | null {
  if (api == null && sulfur == null) return null;
  // Condensate covers everything > 45° API regardless of sulfur (it's
  // already trivially sweet at that gravity).
  if (api != null && api > 45) return 'condensate';
  const heavy = api != null && api < 22;
  const light = api != null && api >= 32;
  // The "medium" sulfur band (0.5-1.0%) gets bucketed with sweet for
  // the badge — operators don't think of 0.7% S as "sour."
  const isSour = sulfur != null && sulfur >= 1.0;
  if (heavy) return isSour ? 'heavy-sour' : 'heavy-sweet';
  if (light) return isSour ? 'light-sour' : 'light-sweet';
  // medium API
  return isSour ? 'medium-sour' : 'medium-sweet';
}

function ClassificationPill({ kind }: { kind: Classification }): ReactNode {
  const label =
    kind === 'condensate'
      ? 'Condensate'
      : kind
          .split('-')
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join(' ');
  // Color by API band (left→right of pill background); border by
  // sulfur band. Subtle — should read as informational, not alarmist.
  const bg =
    kind.startsWith('heavy')
      ? 'rgba(190, 60, 60, 0.10)'
      : kind.startsWith('light') || kind === 'condensate'
        ? 'rgba(34, 139, 84, 0.10)'
        : 'rgba(220, 165, 50, 0.12)';
  const fg =
    kind.startsWith('heavy')
      ? 'rgb(160, 50, 50)'
      : kind.startsWith('light') || kind === 'condensate'
        ? 'rgb(28, 110, 70)'
        : 'rgb(165, 110, 25)';
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ backgroundColor: bg, color: fg }}
    >
      {label}
    </span>
  );
}

// ─── Hero scales (API + Sulfur) ─────────────────────────────────

function HeroScales({
  apiGravity,
  sulfurPct,
}: {
  apiGravity: number | null;
  sulfurPct: number | null;
}): ReactNode {
  if (apiGravity == null && sulfurPct == null) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {apiGravity != null ? (
        <PropertyScale
          label="API Gravity"
          value={apiGravity}
          unit="°"
          min={10}
          max={55}
          bands={[
            { from: 10, to: 22, label: 'Heavy', color: 'rgba(190, 60, 60, 0.20)' },
            { from: 22, to: 32, label: 'Medium', color: 'rgba(220, 165, 50, 0.22)' },
            { from: 32, to: 45, label: 'Light', color: 'rgba(34, 139, 84, 0.20)' },
            { from: 45, to: 55, label: 'Cond.', color: 'rgba(34, 139, 84, 0.30)' },
          ]}
          decimals={1}
        />
      ) : null}
      {sulfurPct != null ? (
        <PropertyScale
          label="Sulfur"
          value={sulfurPct}
          unit="% wt"
          min={0}
          max={3.5}
          bands={[
            { from: 0, to: 0.5, label: 'Sweet', color: 'rgba(34, 139, 84, 0.20)' },
            { from: 0.5, to: 1.0, label: 'Med', color: 'rgba(220, 165, 50, 0.22)' },
            { from: 1.0, to: 3.5, label: 'Sour', color: 'rgba(190, 60, 60, 0.20)' },
          ]}
          decimals={2}
        />
      ) : null}
    </div>
  );
}

/**
 * Horizontal range bar with the grade's value plotted as a marker
 * and quality bands shading the background. Unit appears next to
 * the headline value.
 */
function PropertyScale({
  label,
  value,
  unit,
  min,
  max,
  bands,
  decimals,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  bands: Array<{ from: number; to: number; label: string; color: string }>;
  decimals: number;
}): ReactNode {
  const span = max - min;
  const clamped = Math.max(min, Math.min(max, value));
  const markerPct = ((clamped - min) / span) * 100;
  const valueBand = bands.find((b) => value >= b.from && value < b.to) ?? bands[bands.length - 1]!;

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/15 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {label}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {valueBand.label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums leading-none">
          {value.toFixed(decimals)}
        </span>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">{unit}</span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-full">
        {/* Band backgrounds */}
        <div className="absolute inset-0 flex">
          {bands.map((b) => (
            <div
              key={b.label}
              style={{
                width: `${((b.to - b.from) / span) * 100}%`,
                backgroundColor: b.color,
              }}
            />
          ))}
        </div>
        {/* Value marker */}
        <div
          className="absolute top-0 h-full w-[2px] -translate-x-1/2 bg-[color:var(--color-foreground)]"
          style={{ left: `${markerPct}%` }}
          aria-hidden
        />
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-[color:var(--color-muted-foreground)]">
        <span>{min}</span>
        {bands.slice(0, -1).map((b) => (
          <span key={b.label}>{b.to}</span>
        ))}
        <span>{max}</span>
      </div>
    </div>
  );
}

// ─── Other properties (TAN, density, V/Ni, viscosity, pour pt) ──

function OtherProperties({
  freshest,
  tan,
}: {
  freshest: CrudeGradeDetailOutput['assays'][number] | null;
  tan: number | null;
}): ReactNode {
  const items: Array<{ label: string; value: string; suffix?: string }> = [];
  if (tan != null) {
    items.push({
      label: 'TAN',
      value: tan.toFixed(2),
      suffix: ' mgKOH/g',
    });
  }
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
  if (freshest?.bblPerMt != null) {
    items.push({
      label: 'bbl/mt',
      value: freshest.bblPerMt.toFixed(2),
    });
  }
  if (items.length === 0) {
    // The hero scales already cover API + sulfur. Don't render an
    // empty grid; the omission is the message.
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 px-2.5 py-1.5"
        >
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            {it.label}
          </div>
          <div className="text-sm font-semibold leading-tight tabular-nums">
            {it.value}
            <span className="text-[10px] font-normal text-[color:var(--color-muted-foreground)]">
              {it.suffix}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── TBP cut chart + empty state ─────────────────────────────────

function CutSection({
  assays,
}: {
  assays: CrudeGradeDetailOutput['assays'];
}): ReactNode {
  const freshest = assays[0] ?? null;
  if (!freshest) {
    return (
      <EmptyBlock
        title="No producer assay published"
        body="Properties shown above come from curated reference data. We haven't ingested a BP / Equinor / ExxonMobil / TotalEnergies assay for this grade yet — TBP cut yields will appear here when one lands."
      />
    );
  }
  const drawn = freshest.cuts.filter((c) => c.yieldWtPct != null && c.yieldWtPct > 0);
  if (drawn.length === 0) {
    return (
      <EmptyBlock
        title="TBP cut data not extracted"
        body={`${producerLabel(freshest.source)} published this assay but its cut block uses a per-product-family layout we haven't structured yet. Whole-crude properties above are accurate; cut yields are queued for the next parser pass.`}
      />
    );
  }
  return <TbpCutChart cuts={drawn} sourceLabel={producerLabel(freshest.source)} freshness={freshest.assayDate} />;
}

function TbpCutChart({
  cuts,
  sourceLabel,
  freshness,
}: {
  cuts: CrudeGradeDetailOutput['assays'][number]['cuts'];
  sourceLabel: string;
  freshness: string | null;
}): ReactNode {
  const total = cuts.reduce((acc, c) => acc + (c.yieldWtPct ?? 0), 0);
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader
        label="TBP cut yields"
        meta={`${sourceLabel}${freshness ? ` · ${freshness}` : ''}`}
      />
      <div className="flex flex-col gap-1">
        {cuts.map((cut) => {
          const widthPct = total > 0 ? ((cut.yieldWtPct ?? 0) / total) * 100 : 0;
          // Color the bar by where the cut sits in the boiling
          // curve — naphtha / kerosene / gasoil / vacuum residue.
          const color = bandColorForCut(cut);
          return (
            <div key={cut.cutOrder} className="grid grid-cols-[8.5rem,1fr,3.5rem] items-center gap-2">
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
              <div className="h-3.5 rounded-full bg-[color:var(--color-muted)]/25">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${widthPct.toFixed(1)}%`, backgroundColor: color }}
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

function bandColorForCut(cut: {
  startTempC: number | null;
  endTempC: number | null;
}): string {
  // Use end_temp_c as the primary band marker (the cut "ends" at
  // its heaviest fraction). Match conventional refining bands:
  //   < 175°C: light naphtha (light blue)
  //   175-230°C: heavy naphtha / kero (medium blue)
  //   230-370°C: gasoil (purple)
  //   370-550°C: vacuum gasoil (amber)
  //   > 550°C: vacuum residue (deep red)
  const end = cut.endTempC ?? cut.startTempC;
  if (end == null) return 'rgba(94, 109, 138, 0.65)';
  if (end < 175) return 'rgba(96, 165, 215, 0.85)';
  if (end < 230) return 'rgba(70, 130, 200, 0.85)';
  if (end < 370) return 'rgba(120, 110, 200, 0.80)';
  if (end < 550) return 'rgba(220, 165, 50, 0.85)';
  return 'rgba(165, 70, 60, 0.85)';
}

// ─── Producer comparison table ───────────────────────────────────

function ProducerComparison({
  assays,
}: {
  assays: CrudeGradeDetailOutput['assays'];
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader label="Producer assays" meta={`${assays.length} vintages`} />
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
            {assays.map((a, idx) => (
              <tr
                key={`${a.source}-${a.reference}`}
                className="border-t border-[color:var(--color-border)]"
              >
                <td className="px-2 py-1.5 font-medium">
                  {producerLabel(a.source)}
                  {idx === 0 ? (
                    <span className="ml-1.5 rounded bg-[color:var(--color-accent)]/15 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wide text-[color:var(--color-accent)]">
                      latest
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 text-[color:var(--color-muted-foreground)] tabular-nums">
                  {a.assayDate ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {a.apiGravity?.toFixed(1) ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {a.sulphurWtPct?.toFixed(2) ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {a.acidityMgKohG?.toFixed(2) ?? '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {a.vanadiumMgKg != null || a.nickelMgKg != null
                    ? `${a.vanadiumMgKg?.toFixed(0) ?? '—'} / ${a.nickelMgKg?.toFixed(0) ?? '—'}`
                    : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  {a.pourPointC?.toFixed(0) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Compatible refineries ──────────────────────────────────────

function CompatibleRefineries({
  refineries,
}: {
  refineries: CrudeGradeDetailOutput['compatibleRefineries'];
}): ReactNode {
  if (refineries.length === 0) {
    return (
      <EmptyBlock
        title="No compatible refineries curated yet"
        body="Once analyst-seeded slate envelopes cover this grade, refineries that can run it will surface here. (See seed-refinery-slate.ts for the current Tier 1/2 set.)"
      />
    );
  }
  // Sort: complexityIndex DESC, capacity DESC. Refineries with no
  // NCI sink to the bottom so high-complexity facilities lead.
  const sorted = [...refineries].sort((a, b) => {
    const ai = a.complexityIndex ?? -1;
    const bi = b.complexityIndex ?? -1;
    if (ai !== bi) return bi - ai;
    return (b.capacityBpd ?? 0) - (a.capacityBpd ?? 0);
  });
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader label="Compatible refineries" meta={`${refineries.length}`} />
      <div className="flex flex-wrap gap-1.5">
        {sorted.slice(0, 16).map((r) => (
          <a
            key={r.slug}
            href={`/entities/${r.slug}`}
            className="group flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/15 px-2.5 py-1 text-[11px] hover:border-[color:var(--color-accent)]/40 hover:bg-[color:var(--color-muted)]/35"
            title={
              r.complexityIndex != null
                ? `Nelson Complexity ${r.complexityIndex.toFixed(1)}` +
                  (r.capacityBpd ? ` · ${(r.capacityBpd / 1000).toFixed(0)} kbd CDU` : '')
                : undefined
            }
          >
            <span className="font-medium leading-none">{r.name}</span>
            <span className="text-[9px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              {r.country}
            </span>
            {r.complexityIndex != null ? (
              <span className="rounded bg-[color:var(--color-background)] px-1 py-0.5 text-[9px] font-medium tabular-nums text-[color:var(--color-muted-foreground)]">
                NCI {r.complexityIndex.toFixed(1)}
              </span>
            ) : null}
          </a>
        ))}
        {sorted.length > 16 ? (
          <span className="self-center text-[11px] text-[color:var(--color-muted-foreground)]">
            +{sorted.length - 16} more
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Notes block ────────────────────────────────────────────────

function NotesBlock({ notes }: { notes: string }): ReactNode {
  return (
    <div className="rounded-[var(--radius-sm)] border-l-2 border-[color:var(--color-accent)]/40 bg-[color:var(--color-muted)]/10 px-3 py-2">
      <p className="text-xs leading-relaxed text-[color:var(--color-muted-foreground)]">{notes}</p>
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────

function SectionHeader({ label, meta }: { label: string; meta?: string }): ReactNode {
  return (
    <div className="flex items-baseline justify-between border-b border-[color:var(--color-border)] pb-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-foreground)]">
        {label}
      </span>
      {meta ? (
        <span className="text-[10px] tabular-nums text-[color:var(--color-muted-foreground)]">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function EmptyBlock({ title, body }: { title: string; body: string }): ReactNode {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-muted)]/10 px-3 py-3">
      <div className="text-[11px] font-medium text-[color:var(--color-foreground)]">{title}</div>
      <div className="mt-0.5 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {body}
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
  // Prefer the producer's label when it carries a real word
  // ("Light Naphtha", "Kerosene", "Vacuum Residue"). Synthesize a
  // `start-end°C` label when the producer label is just numeric.
  if (cut.cutLabel && /[A-Za-z]{2,}/.test(cut.cutLabel)) return cut.cutLabel;
  if (cut.startTempC != null && cut.endTempC != null) {
    return `${cut.startTempC.toFixed(0)}-${cut.endTempC.toFixed(0)}°C`;
  }
  return cut.cutLabel || '?';
}
