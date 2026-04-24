import Link from 'next/link';
import { LIBRARY_TYPES, LIBRARY_TYPE_LABEL } from '../../../lib/library-queries';
import { createLibraryEntryAction } from '../actions';

export const dynamic = 'force-dynamic';

export default function NewLibraryEntryPage() {
  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/library" className="hover:underline">
          Library
        </Link>
        <span> / </span>
        <span>New entry</span>
      </nav>

      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Add library entry</h1>

      <form action={createLibraryEntryAction} className="space-y-4">
        <Field label="Title" required>
          <input
            name="title"
            type="text"
            required
            placeholder="e.g. Company capability statement — 2026"
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </Field>

        <Field label="Type" required>
          <select
            name="type"
            required
            defaultValue="capability_statement"
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {LIBRARY_TYPES.map((t) => (
              <option key={t} value={t}>
                {LIBRARY_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tags" help="Comma-separated. Optional.">
          <input
            name="tags"
            type="text"
            placeholder="e.g. healthcare, caribbean, MoH"
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </Field>

        <Field label="Content" required help="Paste text. The AI drafter will use this as source material.">
          <textarea
            name="content"
            required
            rows={14}
            placeholder="Paste the full content here — the more specific, the better the draft."
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Save
          </button>
          <Link href="/library" className="text-sm underline">
            Cancel
          </Link>
        </div>

        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          On save, content is embedded via OpenAI text-embedding-3-small (1536 dims) and
          indexed with pgvector. Search happens automatically when drafting proposal sections.
        </p>
      </form>
    </div>
  );
}

function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="text-[color:var(--color-brand)]">*</span>}
      </span>
      {help && <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{help}</p>}
      <div className="mt-1">{children}</div>
    </label>
  );
}
