import Link from 'next/link';
import { requireCompany } from '@procur/auth';
import { LIBRARY_TYPE_LABEL, listLibrary } from '../../lib/library-queries';

export const dynamic = 'force-dynamic';

export default async function LibraryListPage() {
  const { company } = await requireCompany();
  const entries = await listLibrary(company.id);

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Content library</h1>
          <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
            Reusable content the AI drafter pulls from when writing proposal sections.
          </p>
        </div>
        <Link
          href="/library/new"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          + Add entry
        </Link>
      </header>

      {entries.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border)] p-10 text-center">
          <p className="font-medium">Nothing in your library yet</p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Start by adding a capability statement, a couple of past performance entries, and
            some team bios. The AI drafter retrieves the top 5 most-relevant entries for each
            proposal section.
          </p>
          <Link
            href="/library/new"
            className="mt-4 inline-block text-sm underline"
          >
            Add your first entry →
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Link
              key={e.id}
              href={`/library/${e.id}`}
              className="block rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4 transition hover:border-[color:var(--color-foreground)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{e.title}</p>
                  <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
                    {LIBRARY_TYPE_LABEL[e.type as keyof typeof LIBRARY_TYPE_LABEL] ?? e.type}
                    {e.tags && e.tags.length > 0 && <> · {e.tags.join(', ')}</>}
                  </p>
                </div>
                <span className="text-xs text-[color:var(--color-muted-foreground)]">
                  {e.embedding ? 'Embedded' : 'Not indexed'}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-[color:var(--color-muted-foreground)]">
                {e.content}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
