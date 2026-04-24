import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getProposalByPursuitId } from '../../../lib/proposal-queries';
import { flagFor, formatDate, timeUntil } from '../../../lib/format';
import {
  createProposalAction,
  updateComplianceMappingAction,
  updateSectionAction,
} from '../actions';

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
            <form action={createProposalAction} className="mt-4">
              <input type="hidden" name="pursuitId" value={pursuitId} />
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
        <Link
          href={`/capture/pursuits/${pursuitId}`}
          className="whitespace-nowrap text-sm underline"
        >
          Pursuit details →
        </Link>
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
                <div className="mt-4 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-3 text-xs text-[color:var(--color-muted-foreground)]">
                  AI drafting, rich-text editing, and content-library retrieval land in Phase 4
                  Day 2+. For now, use this outline to plan offline.
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Compliance matrix ({compliance.length} requirements · {compliancePct}% addressed)
        </h2>
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
                      {row.confidence ? `${Math.round(row.confidence * 100)}%` : '—'}
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
