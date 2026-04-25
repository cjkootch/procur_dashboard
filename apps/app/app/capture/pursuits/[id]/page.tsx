import { notFound } from 'next/navigation';
import Link from 'next/link';
import { and, asc, desc, eq } from 'drizzle-orm';
import { auditLog, contracts, db, documents, opportunities, users } from '@procur/db';
import { requireCompany } from '@procur/auth';
import {
  getPursuitById,
  getPursuitRaw,
  listPursuitTasks,
  type PursuitStageKey,
} from '../../../../lib/capture-queries';
import { CaptureQuestionsForm } from '../../components/capture-questions-form';
import {
  isTabKey,
  PursuitLeftNav,
  type TabKey,
} from '../../pursuits/components/left-nav';
import { PursuitHero } from '../../pursuits/components/pursuit-hero';
import { PursuitRightRail } from '../../pursuits/components/right-rail';
import { PursuitOverviewTab } from '../../pursuits/components/overview-tab';
import { PursuitActivityTab } from '../../pursuits/components/activity-tab';
import { PursuitTasksTab } from '../../pursuits/components/tasks-tab';
import { GateReviewsTab } from '../../pursuits/components/gate-reviews-tab';
import { CapabilitiesTab } from '../../pursuits/components/capabilities-tab';
import { TeamingTab } from '../../pursuits/components/teaming-tab';
import { PursuitDocumentsTab } from '../../pursuits/components/documents-tab';
import { listGateReviewsForPursuit } from '../../../../lib/gate-review-queries';
import {
  listCompanyCapabilities,
  listRequirementsForPursuit,
  summarizeRequirements,
} from '../../../../lib/capability-queries';
import { listTeamMembersForPursuit, summarizeTeam } from '../../../../lib/team-queries';

export const dynamic = 'force-dynamic';

const CAPTURE_QUESTION_BLANK = {
  winThemes: [],
  customerBudget: null,
  customerPainPoints: [],
  incumbents: [],
  competitors: [],
  differentiators: [],
  risksAndMitigations: [],
  teamPartners: [],
  customerRelationships: [],
};

const CAPTURE_QUESTION_KEYS = [
  'winThemes',
  'customerBudget',
  'customerPainPoints',
  'incumbents',
  'competitors',
  'differentiators',
  'risksAndMitigations',
  'teamPartners',
] as const;

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export default async function PursuitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';

  const { company } = await requireCompany();
  const card = await getPursuitById(company.id, id);
  if (!card) notFound();

  const [raw, tasks, oppMeta] = await Promise.all([
    getPursuitRaw(company.id, id),
    listPursuitTasks(id),
    db
      .select({
        description: opportunities.description,
        aiSummary: opportunities.aiSummary,
      })
      .from(opportunities)
      .where(eq(opportunities.id, card.opportunity.id))
      .limit(1),
  ]);
  const oppRow = oppMeta[0];

  const captureAnswers =
    (raw?.captureAnswers as Record<string, unknown> | null) ?? CAPTURE_QUESTION_BLANK;
  const answeredCount = countAnsweredQuestions(captureAnswers);
  const canAdvanceToProposal = hasCoreCaptureAnswers(captureAnswers);

  const openTaskCount = tasks.filter((t) => !t.completedAt).length;

  // Linked contract (only relevant when this pursuit has been awarded).
  const linkedContract =
    card.stage === 'awarded'
      ? await db.query.contracts.findFirst({
          where: and(eq(contracts.pursuitId, id), eq(contracts.companyId, company.id)),
          columns: { id: true },
        })
      : null;

  // Audit log for this pursuit. Only loaded when the Activity tab is
  // active (1 indexed query by entity_type + entity_id, joined with
  // users for the actor name).
  const auditRows =
    tab === 'activity'
      ? await db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            changes: auditLog.changes,
            metadata: auditLog.metadata,
            createdAt: auditLog.createdAt,
            actorFirstName: users.firstName,
            actorLastName: users.lastName,
          })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .where(and(eq(auditLog.entityType, 'pursuit'), eq(auditLog.entityId, id)))
          .orderBy(desc(auditLog.createdAt))
          .limit(200)
      : [];

  // Gate reviews — loaded only when the Gate Reviews tab is active.
  const gateReviews = tab === 'gate-reviews' ? await listGateReviewsForPursuit(id) : [];

  // Team members — loaded only when the Teaming tab is active.
  const teamMembers = tab === 'teaming' ? await listTeamMembersForPursuit(id) : [];
  const teamSummary = summarizeTeam(teamMembers);

  // Capabilities + requirements — loaded only when the Capabilities tab is active.
  const [capabilities, requirements] =
    tab === 'capabilities'
      ? await Promise.all([
          listCompanyCapabilities(company.id),
          listRequirementsForPursuit(id),
        ])
      : [[], []];
  const capabilitySummary = summarizeRequirements(requirements);

  // Documents attached to the underlying opportunity. Loaded only when the
  // Documents tab is active to avoid an extra query on every page view.
  const docRows =
    tab === 'documents'
      ? await db
          .select({
            id: documents.id,
            title: documents.title,
            documentType: documents.documentType,
            originalUrl: documents.originalUrl,
            r2Url: documents.r2Url,
            pageCount: documents.pageCount,
            fileSize: documents.fileSize,
            processingStatus: documents.processingStatus,
          })
          .from(documents)
          .where(eq(documents.opportunityId, card.opportunity.id))
          .orderBy(asc(documents.createdAt))
      : [];

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/capture" className="hover:underline">
          Capture
        </Link>
        <span> / </span>
        <Link href="/capture/pursuits" className="hover:underline">
          Pursuits
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">{card.opportunity.title}</span>
      </nav>

      <PursuitHero card={card} raw={oppRow ?? null} discoverUrl={DISCOVER_URL} />

      {/* 3-col layout on desktop: left mini-nav | main content | right rail.
          Stacks vertically on narrow screens so nothing gets squeezed. */}
      <div className="mt-6 grid gap-6 md:grid-cols-[13rem_1fr_16rem]">
        <PursuitLeftNav
          pursuitId={id}
          activeTab={tab}
          activeStage={card.stage as PursuitStageKey}
          canAdvanceToProposal={canAdvanceToProposal}
          captureAnswersCount={answeredCount}
          totalCaptureQuestions={CAPTURE_QUESTION_KEYS.length}
          openTaskCount={openTaskCount}
        />

        <main className="min-w-0">
          {tab === 'overview' && (
            <PursuitOverviewTab
              card={card}
              rawAiSummary={oppRow?.aiSummary ?? null}
              rawDescription={oppRow?.description ?? null}
            />
          )}
          {tab === 'activity' && raw && (
            <PursuitActivityTab
              pursuitId={card.id}
              pursuit={raw}
              tasks={tasks}
              auditRows={auditRows}
            />
          )}
          {tab === 'capture-questions' && (
            <div className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
              <div className="mb-4 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">
                  Capture questions
                  <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">
                    {answeredCount} of {CAPTURE_QUESTION_KEYS.length} answered
                  </span>
                </h2>
                {!canAdvanceToProposal && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Required before Proposal Development
                  </span>
                )}
              </div>
              <CaptureQuestionsForm pursuitId={card.id} initial={captureAnswers} />
            </div>
          )}
          {tab === 'tasks' && <PursuitTasksTab pursuitId={card.id} tasks={tasks} />}
          {tab === 'gate-reviews' && (
            <GateReviewsTab pursuitId={card.id} reviews={gateReviews} />
          )}
          {tab === 'capabilities' && (
            <CapabilitiesTab
              pursuitId={card.id}
              capabilities={capabilities}
              requirements={requirements}
              summary={capabilitySummary}
            />
          )}
          {tab === 'teaming' && (
            <TeamingTab pursuitId={card.id} members={teamMembers} summary={teamSummary} />
          )}
          {tab === 'documents' && (
            <PursuitDocumentsTab
              docs={docRows.map((d) => ({
                id: d.id,
                title: d.title,
                documentType: d.documentType,
                originalUrl: d.originalUrl,
                r2Url: d.r2Url,
                pageCount: d.pageCount,
                fileSize: d.fileSize,
                processingStatus: d.processingStatus,
              }))}
              discoverUrl={DISCOVER_URL}
              opportunitySlug={card.opportunity.slug}
            />
          )}
        </main>

        <PursuitRightRail
          card={card}
          assignedUserName={card.assignedUserName}
          linkedContractId={linkedContract?.id ?? null}
        />
      </div>
    </div>
  );
}

function countAnsweredQuestions(a: Record<string, unknown>): number {
  let n = 0;
  for (const k of CAPTURE_QUESTION_KEYS) {
    const v = a[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    n += 1;
  }
  return n;
}

function hasCoreCaptureAnswers(a: Record<string, unknown>): boolean {
  const winThemes = Array.isArray(a.winThemes)
    ? (a.winThemes as string[]).filter((t) => t.trim().length > 0)
    : [];
  const differentiators = Array.isArray(a.differentiators)
    ? (a.differentiators as string[]).filter((t) => t.trim().length > 0)
    : [];
  const bid = a.bidDecision;
  return winThemes.length > 0 && differentiators.length > 0 && (bid === 'bid' || bid === 'no_bid');
}
