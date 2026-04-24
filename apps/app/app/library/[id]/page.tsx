import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCompany } from '@procur/auth';
import {
  getLibraryEntry,
  LIBRARY_TYPES,
  LIBRARY_TYPE_LABEL,
} from '../../../lib/library-queries';
import { deleteLibraryEntryAction, updateLibraryEntryAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function LibraryEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { company } = await requireCompany();
  const entry = await getLibraryEntry(company.id, id);
  if (!entry) notFound();

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/library" className="hover:underline">
          Library
        </Link>
        <span> / </span>
        <span>{entry.title}</span>
      </nav>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Edit entry</h1>
      <p className="mb-6 text-xs text-[color:var(--color-muted-foreground)]">
        Version {entry.version} · {entry.embedding ? 'Indexed for semantic search' : 'Not indexed'}
      </p>

      <form action={updateLibraryEntryAction} className="space-y-4">
        <input type="hidden" name="id" value={entry.id} />
        <label className="block">
          <span className="text-sm font-medium">Title</span>
          <input
            name="title"
            type="text"
            required
            defaultValue={entry.title}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Type</span>
          <select
            name="type"
            defaultValue={entry.type}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            {LIBRARY_TYPES.map((t) => (
              <option key={t} value={t}>
                {LIBRARY_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Tags</span>
          <input
            name="tags"
            type="text"
            defaultValue={entry.tags?.join(', ') ?? ''}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Content</span>
          <textarea
            name="content"
            required
            rows={16}
            defaultValue={entry.content}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-1.5 text-sm"
          />
        </label>
        <div className="flex items-center justify-between">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Save
          </button>
        </div>
      </form>

      <form action={deleteLibraryEntryAction} className="mt-8 border-t border-[color:var(--color-border)] pt-6">
        <input type="hidden" name="id" value={entry.id} />
        <button
          type="submit"
          className="text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
        >
          Delete this entry
        </button>
      </form>
    </div>
  );
}
