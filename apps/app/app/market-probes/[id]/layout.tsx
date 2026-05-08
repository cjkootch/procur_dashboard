import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireCompany } from '@procur/auth';
import { getProbe } from '@procur/catalog';
import { advanceLadderAction } from '../actions';
import { ProbeTabs } from './_components/ProbeTabs';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-green-100 text-green-900',
  planning: 'bg-amber-100 text-amber-900',
  paused: 'bg-amber-100 text-amber-900',
  completed: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]',
  abandoned: 'bg-red-100 text-red-900',
};

const LADDER_STAGES = [
  'market_structure',
  'routing',
  'pain_discovery',
  'commercial_qualification',
  'deal_room_conversion',
] as const;

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ id: string }>;
}

export default async function ProbeLayout({ children, params }: LayoutProps) {
  await requireCompany();
  const { id } = await params;
  const probe = await getProbe(id);
  if (!probe) notFound();

  const ladderIdx = LADDER_STAGES.indexOf(
    probe.ladderStage as (typeof LADDER_STAGES)[number],
  );
  const ladderNext = ladderIdx >= 0 ? LADDER_STAGES[ladderIdx + 1] : undefined;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <Link
        href="/market-probes"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Market Probes
      </Link>
      <header className="mt-4 mb-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {probe.marketName}
          </h1>
          {probe.country && (
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
              {probe.country.toUpperCase()}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[probe.status] ?? ''}`}
          >
            {probe.status}
          </span>
          <span className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs">
            Tier {probe.tier}
          </span>
          <span
            className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs font-mono"
            title="Probe ladder stage. Sequential: market_structure → routing → pain_discovery → commercial_qualification → deal_room_conversion."
          >
            stage: {probe.ladderStage}
          </span>
          {ladderNext && (
            <>
              <form action={advanceLadderAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <button
                  type="submit"
                  className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-muted)]/40"
                  title={`Advance to ${ladderNext}. Gated on evidence from current stage.`}
                >
                  advance →
                </button>
              </form>
              <form action={advanceLadderAction}>
                <input type="hidden" name="probeId" value={probe.id} />
                <input type="hidden" name="force" value="true" />
                <button
                  type="submit"
                  className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
                  title={`Force-advance to ${ladderNext} regardless of evidence. Operator-only override.`}
                >
                  force
                </button>
              </form>
            </>
          )}
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            cap {probe.dailySendLimit}/day, {probe.totalSendLimit} total
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm">{probe.productThesis}</p>
        {probe.objective && (
          <p className="mt-2 max-w-3xl text-xs text-[color:var(--color-muted-foreground)]">
            Objective: {probe.objective}
          </p>
        )}
      </header>

      <ProbeTabs probeId={probe.id} />

      {children}
    </div>
  );
}
