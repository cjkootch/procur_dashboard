import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import { SHRED_TYPES, type ProposalShred, type ShredType } from '@procur/db';
import {
  getOwnedProposalWithOpportunity,
  getSourceDocumentTitlesForProposal,
  groupShredsBySection,
  listAvailableShredDocuments,
  listShredsForProposal,
  SHRED_TYPE_LABEL,
  summarizeShreds,
  type AvailableShredDocument,
  type ShredSummary,
} from '../../../../lib/shred-queries';
import { chipClass, type ChipTone } from '../../../../lib/chips';
import {
  addShredAction,
  clearAllShredsAction,
  removeShredAction,
  shredRfpFromDocumentAction,
  shredRfpFromTextAction,
  toggleShredAccountedForAction,
  updateShredAction,
} from '../../actions';

export const dynamic = 'force-dynamic';
// shredRfpFromTextAction can run 30-90s on long RFP sections. Default
// Vercel maxDuration is 60s on Pro, so we bump to 120s explicitly.
export const maxDuration = 120;

const TYPE_TONE: Record<ShredType, ChipTone> = {
  shall: 'danger',
  must: 'danger',
  will: 'warning',
  should: 'info',
  may: 'neutral',
  none: 'neutral',
};

type Params = { pursuitId: string };

export default async function ShredPage({ params }: { params: Promise<Params> }) {
  const { pursuitId } = await params;
  const { company } = await requireCompany();

  const proposal = await getOwnedProposalWithOpportunity(company.id, pursuitId);
  if (!proposal) notFound();

  const [shreds, documentsAvailable, sourceDocTitles] = await Promise.all([
    listShredsForProposal(proposal.id),
    listAvailableShredDocuments(proposal.opportunityId),
    getSourceDocumentTitlesForProposal(proposal.id),
  ]);
  const summary = summarizeShreds(shreds);
  const groups = groupShredsBySection(shreds);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <nav className="mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        <Link href="/proposal" className="hover:underline">
          Proposal
        </Link>
        <span> / </span>
        <Link href={`/proposal/${pursuitId}`} className="hover:underline">
          Detail
        </Link>
        <span> / </span>
        <span className="text-[color:var(--color-foreground)]">Compliance shred</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Compliance shred</h1>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Sentence-level extract of every compliance verb in the RFP — shall, will, must,
            should, may. Toggle &ldquo;accounted for&rdquo; once each mandatory item is addressed in
            the proposal.
          </p>
        </div>
        <Link
          href={`/proposal/${pursuitId}`}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-muted)]/40"
        >
          ← Back to proposal
        </Link>
      </header>

      <SummaryStrip summary={summary} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_18rem]">
        <main className="space-y-5 min-w-0">
          {/* Auto-shred from uploaded documents (preferred) */}
          {documentsAvailable.length > 0 && (
            <AutoShredCard pursuitId={pursuitId} docs={documentsAvailable} />
          )}

          {/* Bulk import */}
          <BulkImportCard pursuitId={pursuitId} hasShreds={shreds.length > 0} />

          {/* Manual add */}
          <ManualAddCard pursuitId={pursuitId} />

          {/* Shred list */}
          {groups.length === 0 ? (
            <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-10 text-center text-sm text-[color:var(--color-muted-foreground)]">
              No shreds yet. Paste a section of the RFP into the bulk import above and
              click &ldquo;Classify with AI&rdquo; to extract every compliance sentence in one pass.
            </section>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <SectionGroup
                  key={g.sectionPath}
                  pursuitId={pursuitId}
                  sectionPath={g.sectionPath}
                  sectionTitle={g.sectionTitle}
                  shreds={g.shreds}
                  sourceDocTitles={sourceDocTitles}
                />
              ))}
            </div>
          )}
        </main>

        <aside className="space-y-3">
          <Legend />
          <DangerZone pursuitId={pursuitId} hasShreds={shreds.length > 0} />
        </aside>
      </div>
    </div>
  );
}

function SummaryStrip({ summary }: { summary: ShredSummary }) {
  const accountedPct =
    summary.mandatoryTotal === 0
      ? 0
      : Math.round((summary.mandatoryAccounted / summary.mandatoryTotal) * 100);
  return (
    <section className="grid gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4 sm:grid-cols-5">
      <Stat label="Total sentences" value={summary.total.toString()} />
      <Stat label="Mandatory" value={summary.mandatoryTotal.toString()} tone="danger" />
      <Stat
        label="Accounted for"
        value={`${summary.mandatoryAccounted} (${accountedPct}%)`}
        tone={accountedPct === 100 ? 'success' : accountedPct > 0 ? 'warning' : 'danger'}
        hint={
          summary.mandatoryTotal > 0 && accountedPct < 100
            ? `${summary.mandatoryTotal - summary.mandatoryAccounted} mandatory items still open`
            : null
        }
      />
      <Stat label="Sections" value={summary.sectionsCount.toString()} />
      <Stat
        label="Shall / Will / Must"
        value={`${summary.byType.shall} / ${summary.byType.will} / ${summary.byType.must}`}
      />
    </section>
  );
}

function AutoShredCard({
  pursuitId,
  docs,
}: {
  pursuitId: string;
  docs: AvailableShredDocument[];
}) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <h2 className="text-sm font-semibold">Shred from an uploaded document</h2>
      <p className="mt-1 mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        Pick a document already attached to this opportunity and Claude will extract
        every compliance sentence from its full text. Documents over 200k characters
        are truncated; chunk-based processing for larger documents is coming soon.
      </p>
      <form
        action={shredRfpFromDocumentAction}
        className="grid gap-2 sm:grid-cols-[1fr_auto]"
      >
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <select
          name="documentId"
          required
          defaultValue=""
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        >
          <option value="" disabled>
            Choose a document…
          </option>
          {docs.map((d) => {
            const kchars = Math.round(d.textLength / 1000);
            const trunc = d.textLength > 200_000 ? ' · truncated' : '';
            const pages = d.pageCount ? ` · ${d.pageCount} pages` : '';
            return (
              <option key={d.id} value={d.id}>
                {d.title} ({d.documentType}){pages} · {kchars}k chars{trunc}
              </option>
            );
          })}
        </select>
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Shred document
        </button>
      </form>
    </section>
  );
}

function BulkImportCard({
  pursuitId,
  hasShreds,
}: {
  pursuitId: string;
  hasShreds: boolean;
}) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <h2 className="text-sm font-semibold">Bulk import — paste RFP text</h2>
      <p className="mt-1 mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        Paste a section, volume, or attachment from the RFP. Claude (Sonnet 4.6) extracts
        every compliance sentence verbatim and classifies the verb. Existing shreds are
        preserved — new rows are appended below.
      </p>
      <form action={shredRfpFromTextAction} className="space-y-2">
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <input
          name="sectionHint"
          aria-label="Section hint"
          placeholder="Section hint (optional, e.g. 'Volume I')"
          className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        />
        <textarea
          name="rfpText"
          rows={hasShreds ? 6 : 12}
          required
          aria-label="RFP section text to classify"
          maxLength={200_000}
          placeholder="Paste RFP section text here…"
          className="w-full resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 font-mono text-xs"
        />
        <div className="flex justify-end">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            Classify with AI
          </button>
        </div>
      </form>
    </section>
  );
}

function ManualAddCard({ pursuitId }: { pursuitId: string }) {
  return (
    <details className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
        Add a single sentence manually
      </summary>
      <div className="border-t border-[color:var(--color-border)] p-4">
        <form
          action={addShredAction}
          className="grid gap-2 sm:grid-cols-[0.6fr_0.8fr_2fr_0.6fr_auto]"
        >
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <input
            name="sectionPath"
            aria-label="Section number"
            placeholder="Section (e.g. 1.1.3)"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="sectionTitle"
            aria-label="Section title"
            placeholder="Section title"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <input
            name="sentenceText"
            aria-label="Sentence verbatim"
            placeholder="Sentence verbatim"
            required
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
          <select
            name="shredType"
            aria-label="Shred type"
            defaultValue="shall"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {SHRED_TYPES.map((t) => (
              <option key={t} value={t}>
                {SHRED_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            + Add
          </button>
        </form>
      </div>
    </details>
  );
}

function SectionGroup({
  pursuitId,
  sectionPath,
  sectionTitle,
  shreds,
  sourceDocTitles,
}: {
  pursuitId: string;
  sectionPath: string;
  sectionTitle: string | null;
  shreds: ProposalShred[];
  sourceDocTitles: Record<string, string>;
}) {
  const mandatory = shreds.filter((s) =>
    (['shall', 'will', 'must'] as ShredType[]).includes(s.shredType),
  );
  const accounted = mandatory.filter((s) => s.accountedFor).length;

  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[color:var(--color-border)] px-4 py-2">
        <div className="flex flex-wrap items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold">{sectionPath}</span>
          {sectionTitle && (
            <span className="text-sm text-[color:var(--color-muted-foreground)]">
              {sectionTitle}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
          {shreds.length} sentences · {mandatory.length} mandatory · {accounted}/{mandatory.length}{' '}
          accounted for
        </span>
      </header>
      <ul className="divide-y divide-[color:var(--color-border)]/60">
        {shreds.map((s) => (
          <ShredRow
            key={s.id}
            shred={s}
            pursuitId={pursuitId}
            sourceDocTitle={s.sourceDocumentId ? sourceDocTitles[s.sourceDocumentId] : null}
          />
        ))}
      </ul>
    </section>
  );
}

function ShredRow({
  shred,
  pursuitId,
  sourceDocTitle,
}: {
  shred: ProposalShred;
  pursuitId: string;
  sourceDocTitle: string | null | undefined;
}) {
  const isMandatory = (['shall', 'will', 'must'] as ShredType[]).includes(shred.shredType);
  return (
    <li className="px-4 py-2">
      {sourceDocTitle && (
        <div className="mb-1 text-[10px] text-[color:var(--color-muted-foreground)]">
          from <span className="italic">{sourceDocTitle}</span>
        </div>
      )}
      <div className="grid items-start gap-2 sm:grid-cols-[1.5rem_1fr_5.5rem_8rem_5rem]">
        {/* Accounted-for checkbox */}
        <form action={toggleShredAccountedForAction} className="pt-1">
          <input type="hidden" name="shredId" value={shred.id} />
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <button
            type="submit"
            role="checkbox"
            aria-checked={shred.accountedFor}
            aria-label={shred.accountedFor ? 'Mark not accounted for' : 'Mark accounted for'}
            title={
              isMandatory
                ? shred.accountedFor
                  ? 'Mandatory item — accounted for'
                  : 'Mandatory item — not yet accounted for'
                : 'Toggle accounted for'
            }
            className={`flex h-5 w-5 items-center justify-center rounded border text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-foreground)] ${
              shred.accountedFor
                ? 'border-emerald-500 bg-emerald-500 text-white'
                : 'border-[color:var(--color-foreground)]/40 bg-[color:var(--color-background)] hover:bg-[color:var(--color-muted)]/40'
            }`}
          >
            <span aria-hidden>{shred.accountedFor ? '✓' : '·'}</span>
          </button>
        </form>

        {/* Sentence + edit */}
        <form
          action={updateShredAction}
          className="grid gap-1 grid-cols-1 sm:grid-cols-[1fr_5.5rem_7rem_5rem]"
          style={{ gridColumn: 'span 4 / span 4' }}
        >
          <input type="hidden" name="shredId" value={shred.id} />
          <input type="hidden" name="pursuitId" value={pursuitId} />
          <textarea
            name="sentenceText"
            aria-label="Sentence text"
            rows={2}
            defaultValue={shred.sentenceText}
            className="w-full resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          />
          <select
            name="shredType"
            aria-label="Shred type"
            defaultValue={shred.shredType}
            className={`rounded-full px-2 py-1 text-[11px] font-medium ${chipClass(TYPE_TONE[shred.shredType])}`}
          >
            {SHRED_TYPES.map((t) => (
              <option key={t} value={t}>
                {SHRED_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <input
            name="addressedInSection"
            aria-label="Addressed in proposal section"
            defaultValue={shred.addressedInSection ?? ''}
            placeholder="Addressed in §"
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
          />
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-1 text-[10px] font-medium text-[color:var(--color-background)]"
          >
            Save
          </button>
        </form>
      </div>

      <form action={removeShredAction} className="mt-1 text-right">
        <input type="hidden" name="shredId" value={shred.id} />
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <button
          type="submit"
          className="text-[10px] text-[color:var(--color-muted-foreground)] hover:text-red-600"
        >
          Remove
        </button>
      </form>
    </li>
  );
}

function Legend() {
  return (
    <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 text-xs">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        Legend
      </p>
      <ul className="space-y-1.5">
        {(['shall', 'must', 'will', 'should', 'may', 'none'] as ShredType[]).map((t) => (
          <li key={t} className="flex items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${chipClass(TYPE_TONE[t])}`}
            >
              {SHRED_TYPE_LABEL[t]}
            </span>
            <span className="text-[color:var(--color-muted-foreground)]">
              {LEGEND_DESC[t]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LEGEND_DESC: Record<ShredType, string> = {
  shall: 'Mandatory (US federal verb)',
  must: 'Mandatory',
  will: 'Used as mandatory',
  should: 'Strongly recommended',
  may: 'Optional / permitted',
  none: 'Informational',
};

function DangerZone({
  pursuitId,
  hasShreds,
}: {
  pursuitId: string;
  hasShreds: boolean;
}) {
  if (!hasShreds) return null;
  return (
    <section className="rounded-[var(--radius-md)] border border-red-200 bg-red-50/40 p-3 text-xs">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-red-700">
        Danger zone
      </p>
      <form action={clearAllShredsAction}>
        <input type="hidden" name="pursuitId" value={pursuitId} />
        <button
          type="submit"
          className="rounded-[var(--radius-sm)] border border-red-300 bg-white px-2 py-1 text-[11px] text-red-700 hover:bg-red-100"
        >
          Clear all shreds
        </button>
      </form>
      <p className="mt-2 text-[10px] text-red-700/80">
        Removes every extracted sentence on this proposal. Useful when the source
        document changes substantially.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: ChipTone;
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-red-700'
      : tone === 'warning'
        ? 'text-amber-700'
        : tone === 'success'
          ? 'text-emerald-700'
          : 'text-[color:var(--color-foreground)]';
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
        {label}
      </p>
      <p className={`mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">{hint}</p>
      )}
    </div>
  );
}
