import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db, opportunities } from '@procur/db';
import { requireCompany } from '@procur/auth';
import {
  getHistoricalBenchmark,
  getPricerByPursuitId,
  summarize,
} from '../../../lib/pricer-queries';
import { flagFor, formatDate, formatMoney } from '../../../lib/format';
import { createPricingModelAction, extractPricingStructureAction } from '../actions';
import { isTabKey, PricerTabNav, type TabKey } from '../components/tab-nav';
import { PricerHero } from '../components/pricer-hero';
import { OverviewTab } from '../components/overview-tab';
import { LaborTab } from '../components/labor-tab';
import { IndirectTab } from '../components/indirect-tab';
import { LineItemsTab } from '../components/line-items-tab';

export const dynamic = 'force-dynamic';

const STRATEGY_LABEL: Record<string, string> = {
  labor_hours: 'Labor hours',
  firm_fixed_price: 'Firm fixed price',
  cost_plus: 'Cost plus',
  time_materials: 'Time & materials',
};

type Params = { pursuitId: string };
type Search = { tab?: string };

export default async function PricerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { pursuitId } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';

  const { company } = await requireCompany();
  const detail = await getPricerByPursuitId(company.id, pursuitId);
  if (!detail) notFound();

  const { pricingModel, laborCategories, opportunity } = detail;

  // Empty-state: no pricing model yet — keep the existing create flow.
  if (!pricingModel) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Breadcrumbs title={opportunity.title} />
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6">
          <h2 className="text-lg font-semibold">Start a pricing model</h2>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Create a blank pricing model for this pursuit. You&rsquo;ll add labor categories,
            set indirect rates, and the target value auto-calculates.
          </p>
          <form action={createPricingModelAction} className="mt-4 space-y-3">
            <input type="hidden" name="pursuitId" value={pursuitId} />
            <label className="block">
              <span className="text-sm font-medium">Pricing strategy</span>
              <select
                name="pricingStrategy"
                defaultValue="labor_hours"
                className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
              >
                {Object.entries(STRATEGY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Create pricing model
            </button>
          </form>
        </div>
      </div>
    );
  }

  const summary = summarize(pricingModel, laborCategories);
  const currency = pricingModel.currency ?? 'USD';
  const escalationPct = Number.parseFloat(pricingModel.escalationRate ?? '0') || 0;
  const targetFeePct = Number.parseFloat(pricingModel.targetFeePct ?? '0') || 0;
  const directLabor = summary.totalLaborCost / Math.max(summary.wrapRate, 0.0001);

  // Historical benchmark only on the Overview tab.
  const [oppContext] = await db
    .select({
      category: opportunities.category,
      jurisdictionId: opportunities.jurisdictionId,
      agencyId: opportunities.agencyId,
    })
    .from(opportunities)
    .where(eq(opportunities.id, opportunity.id))
    .limit(1);

  const benchmark =
    tab === 'overview' && oppContext
      ? await getHistoricalBenchmark(
          oppContext.category,
          oppContext.jurisdictionId,
          oppContext.agencyId,
        )
      : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Breadcrumbs title={opportunity.title} />

      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-[color:var(--color-muted-foreground)]">
            <span className="text-base">{flagFor(opportunity.jurisdictionCountry)}</span>
            <span>
              {opportunity.jurisdictionName}
              {opportunity.agencyName && <> · {opportunity.agencyName}</>}
            </span>
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{opportunity.title}</h1>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Procur Pricer · Manage pricing strategy, labor categories, and cost estimates
            {opportunity.deadlineAt && <> · Bid by {formatDate(opportunity.deadlineAt)}</>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-xs">
          <Link href={`/capture/pursuits/${pursuitId}`} className="underline">
            Pursuit details →
          </Link>
          <a
            href={`/api/pricer/${pursuitId}/export`}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Download .xlsx
          </a>
          <form action={extractPricingStructureAction}>
            <input type="hidden" name="pursuitId" value={pursuitId} />
            <button
              type="submit"
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              Extract from Documents
            </button>
          </form>
        </div>
      </header>

      <PricerHero
        pricingModel={pricingModel}
        laborCategories={laborCategories}
        summary={summary}
      />

      <div className="mt-6">
        <PricerTabNav active={tab} pursuitId={pursuitId} laborCount={laborCategories.length} />
      </div>

      <div className="mt-4">
        {tab === 'overview' && (
          <>
            <OverviewTab pricingModel={pricingModel} summary={summary} pursuitId={pursuitId} />
            {benchmark && (
              <section className="mt-4 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
                <h2 className="mb-2 text-sm font-semibold">Historical benchmark</h2>
                <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
                  Past awarded opportunities in the same category. Use as an anchor — actual
                  target depends on scope, performance period, and indirect rates.
                </p>
                <div className="grid gap-3 md:grid-cols-5">
                  <Bench
                    label="Sample"
                    value={`${benchmark.sampleSize} awards`}
                    sub={`${benchmark.sameJurisdictionCount} same jurisdiction · ${benchmark.byAgencyCount} same agency`}
                  />
                  <Bench label="Median" value={formatMoney(benchmark.medianUsd, 'USD') ?? '—'} />
                  <Bench label="Mean" value={formatMoney(benchmark.meanUsd, 'USD') ?? '—'} />
                  <Bench label="Min" value={formatMoney(benchmark.minUsd, 'USD') ?? '—'} />
                  <Bench label="Max" value={formatMoney(benchmark.maxUsd, 'USD') ?? '—'} />
                </div>
              </section>
            )}
          </>
        )}
        {tab === 'labor' && (
          <LaborTab
            laborCategories={laborCategories}
            summary={summary}
            pursuitId={pursuitId}
            hoursPerFte={pricingModel.hoursPerFte ?? 2080}
            escalationPct={escalationPct}
            currency={currency}
          />
        )}
        {tab === 'indirect' && (
          <IndirectTab
            pursuitId={pursuitId}
            pricingModel={pricingModel}
            directLabor={directLabor}
            currency={currency}
          />
        )}
        {tab === 'line-items' && (
          <LineItemsTab
            summary={summary}
            basePeriodMonths={pricingModel.basePeriodMonths ?? 12}
            optionYears={pricingModel.optionYears ?? 0}
            currency={currency}
            targetFeePct={targetFeePct}
          />
        )}
      </div>
    </div>
  );
}

function Breadcrumbs({ title }: { title: string }) {
  return (
    <nav className="mb-4 text-xs text-[color:var(--color-muted-foreground)]">
      <Link href="/pricer" className="hover:underline">
        Pricer
      </Link>
      <span> / </span>
      <span className="text-[color:var(--color-foreground)]">{title}</span>
    </nav>
  );
}

function Bench({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{sub}</p>
      )}
    </div>
  );
}
