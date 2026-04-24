import Link from 'next/link';
import { ingestFileAction } from '../actions';

export const dynamic = 'force-dynamic';

export default function LibraryUploadPage() {
  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <nav className="mb-4 text-sm text-[color:var(--color-muted-foreground)]">
        <Link href="/library" className="hover:underline">
          Library
        </Link>
        <span> / </span>
        <span>Upload</span>
      </nav>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Upload document</h1>
      <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
        PDF, DOCX, TXT, or MD up to 15&nbsp;MB. We extract text, use Haiku to split it into
        logical reusable chunks (capability statements, team bios, past performance, boilerplate),
        and index each chunk with embeddings.
      </p>

      <form action={ingestFileAction} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">File</span>
          <input
            name="file"
            type="file"
            required
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
            className="mt-1 block w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm file:mr-3 file:rounded-[var(--radius-sm)] file:border file:border-[color:var(--color-border)] file:bg-[color:var(--color-muted)] file:px-3 file:py-1 file:text-xs"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
          >
            Extract and ingest
          </button>
          <Link href="/library" className="text-sm underline">
            Cancel
          </Link>
        </div>

        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Processing runs synchronously — large PDFs can take 10-30 seconds. Don&rsquo;t close
          the tab until the redirect lands on /library.
        </p>
      </form>
    </div>
  );
}
