import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getDealRoomContext, type DealRoomContext } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}

const TABS = [
  'overview',
  'counterparties',
  'communications',
  'assistant',
  'documents',
  'structure',
  'compliance',
  'activity',
] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  counterparties: 'Counterparties',
  communications: 'Communications',
  assistant: 'Assistant chats',
  documents: 'Documents',
  structure: 'Structure',
  compliance: 'Compliance',
  activity: 'Activity',
};

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

/**
 * Render the deal volume in its native unit. Fuel deals ship in
 * millions of USG (so we scale + drop the M suffix); food/other
 * lines (kg, lbs, mt, containers) read literally without scaling.
 * Preserves "M USG" only when that's actually the unit on file.
 */
function formatDealVolume(volume: number, unit: string): string {
  const u = (unit || 'usg').toLowerCase();
  if (u === 'usg') {
    return `${(volume / 1_000_000).toFixed(2)}M USG`;
  }
  return `${volume.toLocaleString()} ${u.toUpperCase()}`;
}

/** Per-unit label for the active scenario / cost-stack columns. Fuel
 *  scenarios are priced per USG; food deals are priced per kg/lbs/etc. */
function perUnitLabel(unit: string): string {
  return `/ ${(unit || 'usg').toUpperCase()}`;
}

interface ScenarioResults {
  perUsg?: { landedCost?: number; grossMargin?: number; netMargin?: number };
  totals?: { ebitdaUsd?: number; totalCashExposureUsd?: number };
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

/**
 * /deals/[id] — the deal room. Single landing surface that pivots
 * every related table around the deal id: counterparties (named
 * columns + fuel_deal_participants), communications (touchpoints
 * keyed deal_id + threads via metadata), assistant chats (assistant_
 * threads.deal_id), documents (fuel_deal_documents), structure (cost
 * stack + scenarios + market context — preserved from the previous
 * single-page surface), compliance (OFAC/BIS/EEI + NDA + fee-
 * protection), activity (events + approvals).
 *
 * Single aggregate fetch via getDealRoomContext; tab selection via
 * `?tab=` query param so deep-links work. No client state.
 */
export default async function DealRoomPage({ params, searchParams }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const sp = await searchParams;
  const room = await getDealRoomContext(id);
  if (!room) notFound();

  const tab: Tab = TABS.includes((sp.tab ?? '') as Tab)
    ? (sp.tab as Tab)
    : 'overview';

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <Link
        href="/deals"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Deals
      </Link>

      <DealHeader room={room} />
      <TabNav active={tab} dealId={id} />

      <div className="mt-6">
        {tab === 'overview' && <OverviewTab room={room} dealId={id} />}
        {tab === 'counterparties' && <CounterpartiesTab room={room} />}
        {tab === 'communications' && <CommunicationsTab room={room} />}
        {tab === 'assistant' && <AssistantTab room={room} />}
        {tab === 'documents' && <DocumentsTab room={room} />}
        {tab === 'structure' && <StructureTab room={room} />}
        {tab === 'compliance' && <ComplianceTab room={room} />}
        {tab === 'activity' && <ActivityTab room={room} />}
      </div>
    </div>
  );
}

function DealHeader({ room }: { room: DealRoomContext }) {
  const { deal, buyer } = room;
  return (
    <header className="mt-4 mb-4">
      <div className="flex flex-wrap items-center gap-2">
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
        {!deal.disclosureAllowed && (
          <span
            className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-900"
            title="Disclosure gated by NDA + fee-protection state"
          >
            disclosure not allowed
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
        Buyer: {buyer?.legalName ?? deal.buyerOrgId}
        {' · '}
        {formatDealVolume(deal.volumeUsg, deal.volumeUnit)}{' '}
        {deal.incoterm.toUpperCase()}
        {deal.destinationPort && <> · {deal.destinationPort}</>}
      </p>
    </header>
  );
}

function TabNav({ active, dealId }: { active: Tab; dealId: string }) {
  return (
    <nav className="flex gap-1 border-b border-[color:var(--color-border)] text-sm">
      {TABS.map((t) => (
        <Link
          key={t}
          href={t === 'overview' ? `/deals/${dealId}` : `/deals/${dealId}?tab=${t}`}
          className={`-mb-px border-b-2 px-3 py-2 ${
            active === t
              ? 'border-[color:var(--color-foreground)] font-medium'
              : 'border-transparent text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]'
          }`}
        >
          {TAB_LABEL[t]}
        </Link>
      ))}
    </nav>
  );
}

// ----------------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------------

function OverviewTab({
  room,
  dealId,
}: {
  room: DealRoomContext;
  dealId: string;
}) {
  const { deal, counterparties, communications, documents, activeScenario } =
    room;
  const recentComms = communications.slice(0, 5);
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card title="Counterparties">
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          {counterparties.length} parties attached
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {counterparties.slice(0, 4).map((c, i) => (
            <li key={i}>
              <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">
                {c.role}
              </span>{' '}
              {c.legalName ?? c.contactName ?? '?'}
            </li>
          ))}
        </ul>
        <Link
          href={`/deals/${dealId}?tab=counterparties`}
          className="mt-2 inline-block text-xs underline"
        >
          See all →
        </Link>
      </Card>
      <Card title="Documents">
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          {documents.length} attached
        </p>
        <Link
          href={`/deals/${dealId}?tab=documents`}
          className="mt-2 inline-block text-xs underline"
        >
          Open documents tab →
        </Link>
      </Card>
      <Card title="Recent communications">
        {recentComms.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            None yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {recentComms.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-[10px] font-mono">
                  {c.channel}
                </span>
                <span className="flex-1 truncate">
                  {c.subject ?? c.preview ?? '(no preview)'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link
          href={`/deals/${dealId}?tab=communications`}
          className="mt-2 inline-block text-xs underline"
        >
          See all →
        </Link>
      </Card>
      <Card title="Active scenario">
        {activeScenario ? (
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-[color:var(--color-muted-foreground)]">Name</dt>
            <dd className="font-mono">{activeScenario.scenarioName}</dd>
            <dt className="text-[color:var(--color-muted-foreground)]">
              Sell {perUnitLabel(deal.volumeUnit)}
            </dt>
            <dd className="font-mono">
              ${activeScenario.sellPricePerUsg.toFixed(4)}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No active scenario.
          </p>
        )}
        <Link
          href={`/deals/${dealId}?tab=structure`}
          className="mt-2 inline-block text-xs underline"
        >
          Structure tab →
        </Link>
      </Card>
    </div>
  );
}

function CounterpartiesTab({ room }: { room: DealRoomContext }) {
  if (room.counterparties.length === 0) {
    return <Empty>No counterparties attached.</Empty>;
  }
  return (
    <ul className="space-y-2">
      {room.counterparties.map((c, i) => (
        <li
          key={i}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
              {c.role}
            </span>
            {c.isPrimary && (
              <span className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                primary
              </span>
            )}
            <span className="ml-auto text-xs text-[color:var(--color-muted-foreground)]">
              {c.commissionType && c.commissionType !== 'none' && (
                <>
                  {c.commissionType}
                  {c.commissionValue != null && <> · {c.commissionValue}</>}
                </>
              )}
            </span>
          </div>
          <div className="mt-1 text-sm">
            {c.orgId && (
              <Link href={`/organizations/${c.orgId}`} className="font-medium underline">
                {c.legalName ?? c.orgId}
              </Link>
            )}
            {c.contactId && (
              <>
                {c.orgId && ' · '}
                <Link href={`/contacts/${c.contactId}`} className="underline">
                  {c.contactName ?? c.contactId}
                </Link>
              </>
            )}
          </div>
          {c.notes && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {c.notes}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CommunicationsTab({ room }: { room: DealRoomContext }) {
  if (room.communications.length === 0) {
    return (
      <Empty>
        No communications attached. Use{' '}
        <code className="font-mono">propose_attach_to_deal</code> in chat to
        link a thread, touchpoint, or assistant chat to this deal.
      </Empty>
    );
  }
  return (
    <ul className="space-y-2">
      {room.communications.map((c) => (
        <li
          key={c.id}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 font-mono">
              {c.channel}
            </span>
            <span className="text-[color:var(--color-muted-foreground)]">
              {c.direction}
            </span>
            {c.sourceApprovalId && (
              <Link
                href={`/approvals/${c.sourceApprovalId}`}
                className="text-[color:var(--color-muted-foreground)] underline"
              >
                approval
              </Link>
            )}
            <time
              className="ml-auto text-[color:var(--color-muted-foreground)]"
              dateTime={c.occurredAt.toISOString()}
            >
              {c.occurredAt.toLocaleString()}
            </time>
          </div>
          {c.subject && <p className="mt-1 text-sm font-medium">{c.subject}</p>}
          {c.preview && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {c.preview}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function AssistantTab({ room }: { room: DealRoomContext }) {
  if (room.assistantThreads.length === 0) {
    return (
      <Empty>
        No assistant chats pinned. Pin a chat to this deal via{' '}
        <code className="font-mono">propose_attach_to_deal</code>.
      </Empty>
    );
  }
  return (
    <ul className="space-y-2">
      {room.assistantThreads.map((t) => (
        <li
          key={t.id}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
        >
          <Link
            href={`/assistant/${t.id}`}
            className="text-sm font-medium underline"
          >
            {t.title}
          </Link>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Last message{' '}
            <time dateTime={t.lastMessageAt.toISOString()}>
              {t.lastMessageAt.toLocaleString()}
            </time>
          </p>
        </li>
      ))}
    </ul>
  );
}

function DocumentsTab({ room }: { room: DealRoomContext }) {
  if (room.documents.length === 0) {
    return <Empty>No documents attached.</Empty>;
  }
  return (
    <ul className="space-y-2">
      {room.documents.map((d) => (
        <li
          key={d.id}
          className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
        >
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
            {d.documentType}
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium">{d.filename}</p>
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              Uploaded{' '}
              <time dateTime={d.uploadedAt.toISOString()}>
                {d.uploadedAt.toLocaleString()}
              </time>
              {d.uploadedBy && <> · {d.uploadedBy}</>}
            </p>
            {d.notes && <p className="mt-1 text-xs">{d.notes}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function StructureTab({ room }: { room: DealRoomContext }) {
  const { deal, activeScenario, costStack, marketContext } = room;
  const results = (activeScenario?.resultsJson ?? null) as ScenarioResults | null;
  const unitLabel = perUnitLabel(deal.volumeUnit);
  return (
    <div className="space-y-4">
      {results?.scorecard && (
        <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
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
                    Landed cost {unitLabel}
                  </dt>
                  <dd className="font-mono">
                    ${results.perUsg.landedCost.toFixed(4)}
                  </dd>
                </>
              )}
              {results.perUsg.grossMargin != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Gross margin {unitLabel}
                  </dt>
                  <dd className="font-mono">
                    ${results.perUsg.grossMargin.toFixed(4)}
                  </dd>
                </>
              )}
              {results.perUsg.netMargin != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Net margin {unitLabel}
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
                    ${Math.round(results.totals.ebitdaUsd).toLocaleString('en-US')}
                  </dd>
                </>
              )}
              {results.breakeven?.sellPriceUsg != null && (
                <>
                  <dt className="text-[color:var(--color-muted-foreground)]">
                    Breakeven sell {unitLabel}
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
        <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
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
        <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
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
        </section>
      )}

      {costStack && (
        <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Cost stack (per {(deal.volumeUnit || 'usg').toUpperCase()}, summary)
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
              Compliance
            </dt>
            <dd>${costStack.totalCompliancePerUsg.toFixed(4)}</dd>
            <dt className="font-sans text-[color:var(--color-muted-foreground)]">
              Trade finance
            </dt>
            <dd>${costStack.tradeFinancePerUsg.toFixed(4)}</dd>
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

function ComplianceTab({ room }: { room: DealRoomContext }) {
  const c = room.compliance;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card title="OFAC / BIS / EEI">
        <Row k="OFAC screen" v={c.ofacScreeningStatus.replace(/_/g, ' ')} />
        <Row
          k="BIS license"
          v={
            c.bisLicenseRequired
              ? `${c.bisLicenseNumber ?? 'required'}${c.bisLicenseExpiry ? ' · expires ' + c.bisLicenseExpiry : ''}`
              : 'not required'
          }
        />
        <Row
          k="EEI filing"
          v={c.eeiFilingRequired ? c.eeiItn ?? 'required' : 'not required'}
        />
        <Row k="Compliance hold" v={c.complianceHold ? 'YES' : 'no'} />
        {c.complianceNotes && (
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            {c.complianceNotes}
          </p>
        )}
      </Card>
      <Card title="Commercial protection">
        <Row
          k="NDA"
          v={
            c.ndaSignedAt
              ? `signed ${new Date(c.ndaSignedAt).toLocaleDateString()}`
              : 'not signed'
          }
        />
        <Row k="Fee protection" v={c.feeProtectionStatus ?? 'not set'} />
        <Row
          k="Disclosure allowed"
          v={
            c.disclosureAllowed ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900">
                YES
              </span>
            ) : (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                blocked
              </span>
            )
          }
        />
        {!c.disclosureAllowed && (
          <p className="mt-2 text-xs text-red-700">
            Chat tools refuse to disclose buyer/seller identity or share documents
            until NDA + fee-protection are in place.
          </p>
        )}
      </Card>
    </div>
  );
}

function ActivityTab({ room }: { room: DealRoomContext }) {
  if (room.activity.length === 0) {
    return <Empty>No activity recorded yet.</Empty>;
  }
  return (
    <ul className="space-y-2">
      {room.activity.map((a) => (
        <li
          key={a.id}
          className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3"
        >
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-mono">
            {a.verb}
          </span>
          <div className="flex-1">
            <time
              className="text-xs text-[color:var(--color-muted-foreground)]"
              dateTime={a.occurredAt.toISOString()}
            >
              {a.occurredAt.toLocaleString()}
            </time>
            {a.actorType && (
              <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">
                {a.actorType}:{a.actorId}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------------------------------
// Small shared bits
// ----------------------------------------------------------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-[color:var(--color-muted-foreground)]">{k}</span>
      <span className="ml-auto">{v}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-muted-foreground)]">
      {children}
    </div>
  );
}
