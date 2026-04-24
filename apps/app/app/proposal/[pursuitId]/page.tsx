import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getProposalByPursuitId } from '../../../lib/proposal-queries';
import { getRelevantPastPerformance } from '../../../lib/past-performance-queries';
import { flagFor, formatDate, timeUntil } from '../../../lib/format';
import { templatesForJurisdiction } from '../../../lib/proposal-templates';
import {
  createProposalAction,
  draftSectionAction,
  regenerateComplianceAction,
  reviewProposalAction,
  updateComplianceMappingAction,
  updateSectionAction,
} from '../actions';

type AiReview = {
  overallScore: number;
  overallVerdict: 'red' | 'yellow' | 'green';
  summary: string;
  strengths: string[];
  risks: Array<{ severity: 'low' | 'medium' | 'high'; text: string }>;
  sectionFeedback: Array<{
    sectionId: string;
    score: number;
    suggestions: string[];
  }>;
  generatedAt: string;
};

export const dynamic = 'force-dynamic';

type Params = { pursuitId: string };

type OutlineSection = {
  id: string;
  number: string;
  title: string;
  description: string;
  evaluationCriteria: string[];
  pageLimit?: number;
  mandatoryContent: string[];
};

type ComplianceRow = {
  requirementId: string;
  requirementText: string;
  sourceSection: string;
  addressedInSection?: string;
  status: 'not_addressed' | 'partially_addressed' | 'fully_addressed' | 'confirmed';
  confidence: number;
  notes?: string;
};

type SectionDraft = {
  id: string;
  outlineId: string;
  title: string;
  content: string;
  status: 'empty' | 'ai_drafted' | 'in_review' | 'finalized';
  wordCount: number;
  lastEditedAt: string;
};

const SECTION_STATUS_LABEL: Record<SectionDraft['status'], string> = {
  empty: 'Empty',
  ai_drafted: 'AI draft',
  in_review: 'In review',
  finalized: 'Finalized',
};

const COMPLIANCE_STATUS_LABEL: Record<ComplianceRow['status'], string> = {
  not_addressed: 'Not addressed',
  partially_addressed: 'Partial',
  fully_addressed: 'Addressed',
  confirmed: 'Confirmed',
};

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { pursuitId } = await params;
  const { company } = await requireCompany();
  const detail = await getProposalByPursuitId(company.id, pursuitId);
  if (!detail) notFound();

  const { proposal, opportunity } = detail;
  const countdown = timeUntil(opportunity.deadlineAt);
  const requirements = Array.isArray(opportunity.extractedRequirements)
    ? opportunity.extractedRequirements
    : [];
  const mandatoryDocs = Array.isArray(opportunity.mandatoryDocuments)
    ? (opportunity.mandatoryDocuments as string[])
    : [];

  if (!proposal) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <Breadcrumbs title={opportunity.title} />
        <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6">
          <h2 className="text-lg font-semibold">Start a proposal</h2>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            We&rsquo;ll seed an outline from the AI-extracted requirements and build a compliance
            matrix so you can immediately see what this tender asks for.
          </p>
          {requirements.length === 0 ? (
            <div className="mt-4 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-4 text-sm">
              <p className="font-medium">No extracted requirements yet</p>
              <p className="mt-1 text-[color:var(--color-muted-foreground)]">
                Wait for the AI enrichment pipeline to process this tender&rsquo;s documents.
                Runs automatically on scrape; you can also re-trigger it from the Trigger.dev
                dashboard (task <code>opportunity.extract-requirements</code>).
              </p>
            </div>
          ) : (
            <form action={createProposalAction} className="mt-4 space-y-4">
              <input type="hidden" name="pursuitId" value={pursuitId} />
              <fieldset>
                <legend className="text-sm font-medium">Template</legend>
                <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
                  Pick the response format. Jurisdiction-specific templates include the exact
                  section structure and required documents for that portal.
                </p>
                <div className="space-y-2">
                  {templatesForJurisdiction(opportunity.jurisdictionSlug).map((t, i) => (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 hover:border-[color:var(--color-foreground)]"
                    >
                      <input
                        type="radio"
                        name="templateId"
                        value={t.id}
                        defaultChecked={i === 0}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium">{t.name}</p>
                        <p className="text-xs text-[color:var(--color-muted-foreground)]">
                          {t.description}
                        </p>
                        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                          {t.sections.length} sections ·{' '}
                          {t.sections.map((s) => s.title).join(' → ')}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button
                type="submit"
                className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
              >
                Create proposal from {requirements.length} requirement
                {requirements.length === 1 ? '' : 's'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const outline = (proposal.outline as OutlineSection[] | null) ?? [];
  const compliance = (proposal.complianceMatrix as ComplianceRow[] | null) ?? [];
  const sections = (proposal.sections as SectionDraft[] | null) ?? [];

  const addressedCount = compliance.filter(
    (c) => c.status === 'fully_addressed' || c.status === 'confirmed',
  ).length;
  const compliancePct =
    compliance.length > 0 ? Math.round((addressedCount / compliance.length) * 100) : 0;

  const relevantPP = await getRelevantPastPerformance(
    company.id,
    [opportunity.title, opportunity.description].filter(Boolean).join('\n\n'),
    3,
  );

  return (
    <div className="mx-auto max-w-6xl px-8 py-10">
      <Breadcrumbs title={opportunity.title} />

      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm text-[color:var(--color-muted-foreground)]">
            <span className="text-lg">{flagFor(opportunity.jurisdictionCountry)}</span>
            <span>
              {opportunity.jurisdictionName}
              {opportunity.agencyName && <> · {opportunity.agencyName}</>}
              {opportunity.referenceNumber && <> · {opportunity.referenceNumber}</>}
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{opportunity.title}</h1>
        </div>
        <div className="flex flex-col items-end gap-2 whitespace-nowrap text-sm">
          <form action={reviewProposalAction}>
            <input type="hidden" name="pursuitId" value={pursuitId} />
            <button
              type="submit"
              className="inline-flex items-center rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
            >
              Review with AI
            </button>
          </form>
          <a
            href={`/api/proposal/${pursuitId}/export`}
            className="inline-flex items-center rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)]"
          >
            Download .docx
          </a>
          <Link href={`/capture/pursuits/${pursuitId}`} className="underline">
            Pursuit details →
          </Link>
        </div>
      </header>

      <section className="mb-8 grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-6 md:grid-cols-4">
        <Fact
          label="Closes"
          value={opportunity.deadlineAt ? formatDate(opportunity.deadlineAt) : '—'}
          sub={countdown && countdown !== 'closed' ? `in ${countdown}` : undefined}
        />
        <Fact label="Sections" value={outline.length.toString()} />
        <Fact label="Requirements" value={compliance.length.toString()} />
        <Fact label="Addressed" value={`${compliancePct}%`} sub={`${addressedCount} of ${compliance.length}`} />
      </section>

      {proposal.aiReview && (() => {
        const review = proposal.aiReview as AiReview;
        const verdictStyle = {
          red: 'border-red-200 bg-red-50/40 text-red-900',
          yellow: 'border-amber-200 bg-amber-50/40 text-amber-900',
          green: 'border-emerald-200 bg-emerald-50/40 text-emerald-900',
        }[review.overallVerdict];
        const severityStyle = {
          high: 'bg-red-100 text-red-900',
          medium: 'bg-amber-100 text-amber-900',
          low: 'bg-[color:var(--color-muted)]/60',
        };
        return (
          <section className={`mb-10 rounded-[var(--radius-lg)] border p-6 ${verdictStyle}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-baseline gap-3">
                  <p className="text-xs uppercase tracking-wide opacity-70">AI review</p>
                  <p className="text-2xl font-semibold">{review.overallScore}/100</p>
                  <span className="rounded-full border border-current px-2 py-0.5 text-xs capitalize">
                    {review.overallVerdict}
                  </span>
                </div>
                <p className="mt-2 text-sm">{review.summary}</p>
              </div>
              <form action={reviewProposalAction}>
                <input type="hidden" name="pursuitId" value={pursuitId} />
                <button
                  type="submit"
                  className="rounded-[var(--radius-md)] border border-current/30 bg-white/70 px-3 py-1.5 text-xs font-medium hover:bg-white"
                >
                  Re-run
                </button>
              </form>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              {review.strengths.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-70">
                    Strengths
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {review.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.risks.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-70">
                    Risks
                  </p>
                  <ul className="space-y-1 text-sm">
                    {review.risks.map((r, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${severityStyle[r.severity]}`}
                        >
                          {r.severity}
                        </span>
                        <span>{r.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <p className="mt-4 text-xs opacity-60">
              Generated {formatDate(new Date(review.generatedAt))}
            </p>
          </section>
        );
      })()}

      {relevantPP && relevantPP.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Relevant past performance ({relevantPP.length})
          </h2>
          <p className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
            Top matches from your reference library for this opportunity. These are
            automatically cited when drafting proposal sections.
          </p>
          <div className="space-y-2">
            {relevantPP.map((p) => (
              <Link
                key={p.id}
                href={`/past-performance/${p.id}`}
                className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
              >
                <p className="text-sm font-medium">{p.projectName}</p>
                <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                  {p.customerName}
                </p>
                <p className="mt-2 line-clamp-2 text-xs text-[color:var(--color-muted-foreground)]">
                  {p.scopeDescription}
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Outline ({outline.length} sections)
        </h2>
        <div className="space-y-3">
          {outline.map((sec) => {
            const draft = sections.find((s) => s.outlineId === sec.id);
            return (
              <article
                key={sec.id}
                className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5"
              >
                <header className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-[color:var(--color-muted-foreground)]">
                      Section {sec.number}
                    </p>
                    <form
                      action={updateSectionAction}
                      className="mt-1 flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="pursuitId" value={pursuitId} />
                      <input type="hidden" name="sectionId" value={draft?.id ?? ''} />
                      <input
                        name="title"
                        defaultValue={sec.title}
                        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-base font-semibold"
                      />
                      <select
                        name="status"
                        defaultValue={draft?.status ?? 'empty'}
                        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                      >
                        {(Object.keys(SECTION_STATUS_LABEL) as SectionDraft['status'][]).map(
                          (k) => (
                            <option key={k} value={k}>
                              {SECTION_STATUS_LABEL[k]}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        type="submit"
                        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-xs hover:border-[color:var(--color-foreground)]"
                      >
                        Save
                      </button>
                    </form>
                  </div>
                  {sec.pageLimit && (
                    <span className="text-xs text-[color:var(--color-muted-foreground)]">
                      {sec.pageLimit} pages
                    </span>
                  )}
                </header>
                <p className="text-sm text-[color:var(--color-muted-foreground)]">
                  {sec.description}
                </p>
                {sec.evaluationCriteria.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium">Addresses evaluation criteria:</p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {sec.evaluationCriteria.map((c) => (
                        <li
                          key={c}
                          className="rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-xs"
                        >
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {sec.mandatoryContent.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium">Must include:</p>
                    <ul className="mt-1 space-y-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                      {sec.mandatoryContent.slice(0, 6).map((m, i) => (
                        <li key={i}>· {m}</li>
                      ))}
                      {sec.mandatoryContent.length > 6 && (
                        <li>· …and {sec.mandatoryContent.length - 6} more</li>
                      )}
                    </ul>
                  </div>
                )}
                {draft?.content ? (
                  <div className="mt-4">
                    <div className="mb-2 flex items-center gap-3 text-xs text-[color:var(--color-muted-foreground)]">
                      <span>{draft.wordCount} words</span>
                      <span>·</span>
                      <span>Last edited {new Date(draft.lastEditedAt).toLocaleString()}</span>
                    </div>
                    <article className="max-h-96 overflow-auto whitespace-pre-line rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-4 text-sm leading-relaxed">
                      {draft.content}
                    </article>
                  </div>
                ) : (
                  <div className="mt-4 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs text-[color:var(--color-muted-foreground)]">
                    No draft yet. Use the AI drafter below to generate one from your content
                    library.
                  </div>
                )}

                <form
                  action={draftSectionAction}
                  className="mt-4 flex flex-wrap items-start gap-2 border-t border-[color:var(--color-border)] pt-4"
                >
                  <input type="hidden" name="pursuitId" value={pursuitId} />
                  <input type="hidden" name="sectionId" value={draft?.id ?? ''} />
                  <input
                    name="instruction"
                    type="text"
                    placeholder={
                      draft?.content
                        ? 'Regenerate with guidance (optional)'
                        : 'Any guidance (optional)'
                    }
                    className="flex-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1 text-sm"
                  />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
                  >
                    {draft?.content ? 'Regenerate with AI' : 'Draft with AI'}
                  </button>
                </form>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mb-10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Compliance matrix ({compliance.length} requirements · {compliancePct}% addressed)
          </h2>
          {compliance.length > 0 && (
            <form action={regenerateComplianceAction}>
              <input type="hidden" name="pursuitId" value={pursuitId} />
              <button
                type="submit"
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
                title="Re-run AI mapping of every requirement to the best-fit section. User-confirmed rows are preserved."
              >
                Auto-map with AI
              </button>
            </form>
          )}
        </div>

        {(() => {
          const unaddressed = compliance.filter(
            (c) => c.status === 'not_addressed' || c.status === 'partially_addressed',
          );
          if (unaddressed.length === 0 || compliance.length === 0) return null;
          return (
            <div className="mb-4 rounded-[var(--radius-lg)] border border-red-200 bg-red-50/40 p-4">
              <p className="text-sm font-medium text-red-900">
                {unaddressed.length} requirement{unaddressed.length === 1 ? '' : 's'} still need
                {unaddressed.length === 1 ? 's' : ''} coverage
              </p>
              <ul className="mt-2 list-disc pl-5 text-xs text-red-900/90">
                {unaddressed.slice(0, 5).map((c) => (
                  <li key={c.requirementId} className="mb-0.5 line-clamp-2">
                    {c.requirementText}
                    {c.notes && (
                      <span className="text-red-900/60"> — {c.notes}</span>
                    )}
                  </li>
                ))}
                {unaddressed.length > 5 && (
                  <li className="text-red-900/70">…and {unaddressed.length - 5} more below</li>
                )}
              </ul>
            </div>
          );
        })()}

        {compliance.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            No requirements to map yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--color-border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[color:var(--color-muted)]/40 text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">Requirement</th>
                  <th className="px-3 py-2">Section</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {compliance.map((row) => (
                  <tr key={row.requirementId} className="border-t border-[color:var(--color-border)]">
                    <td className="px-3 py-2">
                      <p className="line-clamp-2">{row.requirementText}</p>
                      {row.sourceSection && (
                        <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                          {row.sourceSection}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <form
                        action={updateComplianceMappingAction}
                        className="flex items-center gap-2"
                      >
                        <input type="hidden" name="pursuitId" value={pursuitId} />
                        <input
                          type="hidden"
                          name="requirementId"
                          value={row.requirementId}
                        />
                        <input type="hidden" name="status" value={row.status} />
                        <select
                          name="addressedInSection"
                          defaultValue={row.addressedInSection ?? ''}
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                        >
                          <option value="">—</option>
                          {outline.map((sec) => (
                            <option key={sec.id} value={sec.id}>
                              {sec.number}. {sec.title}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="text-xs underline text-[color:var(--color-muted-foreground)]"
                        >
                          Save
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2">
                      <form action={updateComplianceMappingAction} className="flex gap-2">
                        <input type="hidden" name="pursuitId" value={pursuitId} />
                        <input
                          type="hidden"
                          name="requirementId"
                          value={row.requirementId}
                        />
                        <input
                          type="hidden"
                          name="addressedInSection"
                          value={row.addressedInSection ?? ''}
                        />
                        <select
                          name="status"
                          defaultValue={row.status}
                          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
                        >
                          {(Object.keys(COMPLIANCE_STATUS_LABEL) as ComplianceRow['status'][]).map(
                            (k) => (
                              <option key={k} value={k}>
                                {COMPLIANCE_STATUS_LABEL[k]}
                              </option>
                            ),
                          )}
                        </select>
                        <button
                          type="submit"
                          className="text-xs underline text-[color:var(--color-muted-foreground)]"
                        >
                          Save
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                      <div>
                        {row.confidence ? `${Math.round(row.confidence * 100)}%` : '—'}
                      </div>
                      {row.notes && (
                        <div className="mt-0.5 text-[color:var(--color-muted-foreground)]/70">
                          {row.notes}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {mandatoryDocs.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Mandatory documents to submit
          </h2>
          <ul className="grid gap-2 md:grid-cols-2">
            {mandatoryDocs.map((d, i) => (
              <li
                key={i}
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] p-3 text-sm"
              >
                {d}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Breadcrumbs({ title }: { title: string }) {
  return (
    <nav className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
      <Link href="/proposal" className="hover:underline">
        Proposals
      </Link>
      <span> / </span>
      <span className="text-[color:var(--color-foreground)]">{title}</span>
    </nav>
  );
}

function Fact({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {sub && <p className="text-xs text-[color:var(--color-muted-foreground)]">{sub}</p>}
    </div>
  );
}
