import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getDealDetail } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

const VERDICT_TONE: Record<string, string> = {
  strong: 'bg-green-100 text-green-900',
  acceptable: 'bg-blue-100 text-blue-900',
  marginal: 'bg-yellow-100 text-yellow-900',
  do_not_proceed: 'bg-red-100 text-red-900',
};
const MARKET_VERDICT_TONE: Record<string, string> = {
  competitive: 'bg-green-100 text-green-900',
  fair: 'bg-blue-100 text-blue-900',
  aggressive: 'bg-yellow-100 text-yellow-900',
  high: 'bg-yellow-100 text-yellow-900',
  outlier_high: 'bg-red-100 text-red-900',
};

interface ScenarioResults {
  perUsg?: {
    landedCost?: number;
    grossMargin?: number;
    netMargin?: number;
  };
  totals?: {
    ebitdaUsd?: number;
    totalCashExposureUsd?: number;
  };
  breakeven?: { sellPriceUsg?: number };
  scorecard?: {
    overallScore?: number;
    recommendation?: string;
    recommendationReason?: string;
  };
  warnings?: Array<{
    code: string;
    severity: 'critical' | 'caution' | 'info';
    message: string;
  }>;
}

export default async function DealDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const detail = await getDealDetail(id);
  if (!detail) notFound();

  const { deal, buyer, activeScenario, costStack, marketContext } = detail;
  const results = (activeScenario?.resultsJson ?? null) as
    | ScenarioResults
    | null;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/deals"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Deals
      </Link>

      <header className="mt-4 mb-6">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            {deal.dealRef}
          </h1>
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {deal.status.replace(/_/g, ' ')}
          </span>
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
            {deal.product}
          </span>
          {deal.complianceHold && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
              compliance hold
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Buyer: {buyer?.legalName ?? deal.buyerOrgId}
          {' · '}
          {(deal.volumeUsg / 1_000_000).toFixed(2)}M USG{' '}
          {deal.incoterm.toUpperCase()}
          {deal.destinationPort && <> · {deal.destinationPort}</>}
        </p>
      </header>

      {results?.scorecard && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Calculator scorecard
            </h2>
            {results.scorecard.recommendation && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT_TONE[results.scorecard.recommendation] ?? ''}`}
              >
                {results.scorecard.recommendation.replace(/_/g, ' ')}
              </span>
            )}
            {results.scorecard.overallScore != null && (
              <span className="ml-auto font-mono text-sm">
                {results.scorecard.overallScore.toFixed(1)} / 100
              </span>
            )}
          </div>
          {results.scorecard.recommendationReason && (
            <p className="mt-2 text-sm">
              {results.scorecard.recommendationReason}
            </p>
          )}
          {results.perUsg && (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              {results.perUsg.landedCost != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Landed cost / USG
                  </dt>
                  <dd className="font-mono">
                    ${results.perUsg.landedCost.toFixed(4)}
                  </dd>
                </>
              )}
              {results.perUsg.grossMargin != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Gross margin / USG
                  </dt>
                  <dd className="font-mono">
                    ${results.perUsg.grossMargin.toFixed(4)}
                  </dd>
                </>
              )}
              {results.perUsg.netMargin != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Net margin / USG
                  </dt>
                  <dd className="font-mono">
                    ${results.perUsg.netMargin.toFixed(4)}
                  </dd>
                </>
              )}
              {results.totals?.ebitdaUsd != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    EBITDA
                  </dt>
                  <dd className="font-mono">
                    $
                    {Math.round(results.totals.ebitdaUsd).toLocaleString(
                      'en-US',
                    )}
                  </dd>
                </>
              )}
              {results.breakeven?.sellPriceUsg != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Breakeven sell / USG
                  </dt>
                  <dd className="font-mono">
                    ${results.breakeven.sellPriceUsg.toFixed(4)}
                  </dd>
                </>
              )}
            </dl>
          )}
        </section>
      )}

      {results?.warnings && results.warnings.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Warnings ({results.warnings.length})
          </h2>
          <ul className="space-y-2 text-sm">
            {results.warnings.slice(0, 12).map((w, i) => (
              <li key={i}>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    w.severity === 'critical'
                      ? 'bg-red-100 text-red-900'
                      : w.severity === 'caution'
                        ? 'bg-yellow-100 text-yellow-900'
                        : 'bg-[color:var(--color-muted)]/60'
                  }`}
                >
                  {w.severity}
                </span>{' '}
                <span className="font-mono text-xs">{w.code}</span>
                <p className="mt-0.5">{w.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {marketContext && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Market context
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${MARKET_VERDICT_TONE[marketContext.verdict] ?? ''}`}
            >
              {marketContext.verdict.replace(/_/g, ' ')}
            </span>
            <span className="ml-auto text-xs font-mono">
              {marketContext.benchmarkCode}
            </span>
          </div>
          {marketContext.rationale && (
            <p className="mt-2 text-sm">{marketContext.rationale}</p>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            {marketContext.benchmarkSpotUsd != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">
                  Benchmark spot
                </dt>
                <dd className="font-mono">
                  ${marketContext.benchmarkSpotUsd.toFixed(2)} / bbl
                </dd>
              </>
            )}
            {marketContext.effectiveBenchmarkUsd != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">
                  Effective benchmark
                </dt>
                <dd className="font-mono">
                  ${marketContext.effectiveBenchmarkUsd.toFixed(2)} / bbl
                </dd>
              </>
            )}
            {marketContext.offerDeltaPct != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">
                  Offer Δ vs mid
                </dt>
                <dd className="font-mono">
                  {(marketContext.offerDeltaPct * 100).toFixed(1)}%
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

      <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Active scenario
        </h2>
        {activeScenario ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-[color:var(--color-muted-foreground)]">Name</dt>
            <dd className="font-mono">{activeScenario.scenarioName}</dd>
            <dt className="text-[color:var(--color-muted-foreground)]">
              Sell price / USG
            </dt>
            <dd className="font-mono">
              ${activeScenario.sellPricePerUsg.toFixed(4)}
            </dd>
            {activeScenario.calculatedAt && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">
                  Last calculated
                </dt>
                <dd>
                  <time dateTime={activeScenario.calculatedAt.toISOString()}>
                    {activeScenario.calculatedAt.toLocaleString()}
                  </time>
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No active scenario.
          </p>
        )}
      </section>

      {costStack && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Cost stack (per USG, summary)
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm font-mono">
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Product
            </dt>
            <dd>${costStack.productCostPerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Freight (all-in)
            </dt>
            <dd>${costStack.freightPerUsgAllIn.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Insurance
            </dt>
            <dd>${costStack.totalInsurancePerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Discharge handling
            </dt>
            <dd>${costStack.dischargeHandlingPerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Compliance
            </dt>
            <dd>${costStack.totalCompliancePerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Trade finance
            </dt>
            <dd>${costStack.tradeFinancePerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Agent / broker
            </dt>
            <dd>${costStack.totalAgentPerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Overhead
            </dt>
            <dd>${costStack.overheadPerUsg.toFixed(4)}</dd>
            <dt className="font-sans font-medium">Total landed</dt>
            <dd className="font-medium">
              ${costStack.totalLandedCostPerUsg.toFixed(4)}
            </dd>
          </dl>
        </section>
      )}
    </div>
  );
}
