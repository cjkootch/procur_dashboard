import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { getLead } from '@procur/catalog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Lead detail per docs/vex-into-procur-merge-brief.md Phase 4. Renders
 * the org + contact + full procur_metadata jsonb (signals, market
 * context, product specs, source documents, ownership, etc.).
 */
export default async function LeadDetailPage({ params }: PageProps) {
  await requireCompany();
  const { id } = await params;
  const detail = await getLead(id);
  if (!detail) notFound();

  const meta = (detail.lead.procurMetadata ?? {}) as {
    pushReason?: string;
    signals?: Array<{
      kind: string;
      occurredAt: string;
      source: string;
      narrative: string;
      weight?: number;
    }>;
    marketContext?: {
      benchmarkAsOf?: string | null;
      brentSpotUsdPerBbl?: number | null;
      nyhDieselSpotUsdPerGal?: number | null;
      nyhGasolineSpotUsdPerGal?: number | null;
    };
    procurApproval?: {
      status: string;
      approvedAt?: string | null;
      expiresAt?: string | null;
      notes?: string | null;
    };
    productSpecs?: Array<{ property: string; typical?: string | null }>;
    sourceDocuments?: Array<{ url: string; filename: string }>;
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/leads"
        className="text-sm text-[color:var(--color-muted-foreground)] hover:underline"
      >
        ← Leads
      </Link>

      <header className="mt-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {detail.org?.legalName ?? '(missing org)'}
        </h1>
        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs font-medium">
            {detail.lead.status}
          </span>
          {detail.lead.stage && (
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
              {detail.lead.stage}
            </span>
          )}
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Created {detail.lead.createdAt.toLocaleString()}
          </span>
        </div>
      </header>

      {meta.pushReason && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Why this lead
          </h2>
          <p className="text-sm">{meta.pushReason}</p>
        </section>
      )}

      {detail.lead.qualificationSummary && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Qualification summary
          </h2>
          <p className="text-sm">{detail.lead.qualificationSummary}</p>
        </section>
      )}

      {detail.contact && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Primary contact
          </h2>
          <p className="text-sm font-medium">{detail.contact.fullName}</p>
          {detail.contact.emails.length > 0 && (
            <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
              {detail.contact.emails.join(', ')}
            </p>
          )}
        </section>
      )}

      {meta.signals && meta.signals.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Signals
          </h2>
          <ul className="space-y-2 text-sm">
            {meta.signals.map((s, i) => (
              <li key={i}>
                <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
                  {s.kind}
                </span>{' '}
                <span className="text-[color:var(--color-muted-foreground)]">
                  {new Date(s.occurredAt).toLocaleDateString()}
                </span>
                <p className="mt-0.5">{s.narrative}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {meta.procurApproval && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            KYC / approval
          </h2>
          <p className="text-sm">
            Status: <span className="font-medium">{meta.procurApproval.status}</span>
          </p>
          {meta.procurApproval.notes && (
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
              {meta.procurApproval.notes}
            </p>
          )}
        </section>
      )}

      {meta.marketContext && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Market context at push
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {meta.marketContext.brentSpotUsdPerBbl != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">Brent (USD/bbl)</dt>
                <dd>{meta.marketContext.brentSpotUsdPerBbl}</dd>
              </>
            )}
            {meta.marketContext.nyhDieselSpotUsdPerGal != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">NYH Diesel ($/gal)</dt>
                <dd>{meta.marketContext.nyhDieselSpotUsdPerGal}</dd>
              </>
            )}
            {meta.marketContext.nyhGasolineSpotUsdPerGal != null && (
              <>
                <dt className="text-[color:var(--color-muted-foreground)]">NYH Gasoline ($/gal)</dt>
                <dd>{meta.marketContext.nyhGasolineSpotUsdPerGal}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      {meta.productSpecs && meta.productSpecs.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Product specs
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[color:var(--color-muted-foreground)]">
                <th className="pb-1">Property</th>
                <th className="pb-1">Typical</th>
              </tr>
            </thead>
            <tbody>
              {meta.productSpecs.map((s, i) => (
                <tr key={i}>
                  <td>{s.property}</td>
                  <td>{s.typical ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {meta.sourceDocuments && meta.sourceDocuments.length > 0 && (
        <section className="mb-6 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Source documents
          </h2>
          <ul className="space-y-1 text-sm">
            {meta.sourceDocuments.map((d, i) => (
              <li key={i}>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {d.filename}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
