import Link from 'next/link';

export type OpportunityDocRow = {
  id: string;
  title: string | null;
  documentType: string;
  originalUrl: string;
  r2Url: string | null;
  pageCount: number | null;
  fileSize: number | null;
  processingStatus: string | null;
};

/**
 * Documents tab — surfaces documents attached to the underlying opportunity
 * (tender notices, tender documents, amendments, addendums) plus a link
 * out to the Discover detail page for the primary source.
 *
 * Full per-pursuit document uploads (with type/tags/status/uploader audit)
 * land in a later phase; this is read-only for now.
 */
export function PursuitDocumentsTab({
  docs,
  discoverUrl,
  opportunitySlug,
}: {
  docs: OpportunityDocRow[];
  discoverUrl: string;
  opportunitySlug: string | null;
}) {
  if (docs.length === 0) {
    return (
      <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-muted-foreground)]">
        <p className="font-medium text-[color:var(--color-foreground)]">No documents attached</p>
        <p className="mt-1">
          Tender documents attached to the opportunity will appear here as the AI pipeline
          processes them.
        </p>
        {opportunitySlug && (
          <a
            className="mt-3 inline-block underline"
            href={`${discoverUrl}/opportunities/${opportunitySlug}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Discover ↗
          </a>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <header className="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
        <h2 className="text-sm font-semibold">Attached documents ({docs.length})</h2>
        {opportunitySlug && (
          <a
            className="text-xs underline"
            href={`${discoverUrl}/opportunities/${opportunitySlug}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Discover ↗
          </a>
        )}
      </header>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[color:var(--color-border)] text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
          <tr>
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 text-right font-medium">Pages</th>
            <th className="px-4 py-2 font-medium">Processing</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-t border-[color:var(--color-border)]">
              <td className="px-4 py-2 font-medium">{d.title ?? '(untitled)'}</td>
              <td className="px-4 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                {humanizeType(d.documentType)}
              </td>
              <td className="px-4 py-2 text-right text-xs text-[color:var(--color-muted-foreground)]">
                {d.pageCount ?? '—'}
              </td>
              <td className="px-4 py-2">
                <StatusChip status={d.processingStatus ?? 'pending'} />
              </td>
              <td className="px-4 py-2 text-right">
                <a
                  href={d.r2Url ?? d.originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline"
                >
                  Open ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const PROC_STYLES: Record<string, string> = {
  completed: 'bg-emerald-500/15 text-emerald-700',
  processing: 'bg-blue-500/15 text-blue-700',
  pending: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]',
  failed: 'bg-red-500/15 text-red-700',
};

function StatusChip({ status }: { status: string }) {
  const cls = PROC_STYLES[status] ?? PROC_STYLES.pending;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

function humanizeType(t: string): string {
  return t.replace(/_/g, ' ');
}
