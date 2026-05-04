'use client';

/**
 * Per-entity documents panel — KYC packs, MSAs, contracts, datasheets,
 * price sheets, compliance screens, correspondence. Per-tenant scoped
 * (one tenant's docs never leak to another).
 *
 * Upload flow:
 *   1. User picks files (drag-drop or click-to-browse).
 *   2. Each file uploads directly to Vercel Blob via the shared
 *      `/api/blob-upload-token` mint endpoint (avoids the 4.5 MB
 *      serverless body limit).
 *   3. Blob URL + metadata is POSTed to /api/entities/{slug}/documents
 *      to record the row.
 *   4. List re-renders with the new entry at the top.
 *
 * Categories (kyc / msa / contract / datasheet / price-sheet /
 * compliance / correspondence / other) are picked at upload time
 * and editable later (TODO: edit-in-place; v1 ships without edit
 * since the wire surface is "delete + re-upload" until that lands).
 */
import { upload } from '@vercel/blob/client';
import { useCallback, useEffect, useRef, useState } from 'react';

const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.txt',
  '.md',
  '.xlsx',
  '.xls',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
];
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

const CATEGORY_LABELS: Record<string, string> = {
  kyc: 'KYC pack',
  msa: 'MSA',
  contract: 'Contract / SPA',
  datasheet: 'Datasheet',
  'price-sheet': 'Price sheet',
  compliance: 'Compliance',
  correspondence: 'Correspondence',
  other: 'Other',
};

type DocumentRow = {
  id: string;
  filename: string;
  blobUrl: string;
  sizeBytes: number | null;
  mimeType: string | null;
  category: string | null;
  description: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
};

type UploadingFile = {
  name: string;
  size: number;
  progress: 'uploading' | 'recording' | 'done' | 'error';
  error?: string;
};

export function EntityDocumentsPanel({
  entitySlug,
  entityName,
}: {
  entitySlug: string;
  entityName: string;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [category, setCategory] = useState<string>('other');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiBase = `/api/entities/${encodeURIComponent(entitySlug)}/documents`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiBase, { cache: 'no-store' });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const json = (await res.json()) as { documents: DocumentRow[] };
      setDocs(json.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files);
    for (const file of list) {
      const lower = file.name.toLowerCase();
      const okType = ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
      if (!okType) {
        setError(
          `"${file.name}" — unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
        );
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`"${file.name}" is ${formatSize(file.size)} (max 100 MB).`);
        continue;
      }
      const tracker: UploadingFile = { name: file.name, size: file.size, progress: 'uploading' };
      setUploading((prev) => [...prev, tracker]);
      try {
        const blob = await upload(`entity-uploads/${crypto.randomUUID()}/${file.name}`, file, {
          access: 'public',
          handleUploadUrl: '/api/blob-upload-token',
        });
        setUploading((prev) =>
          prev.map((u) => (u.name === file.name ? { ...u, progress: 'recording' } : u)),
        );
        const res = await fetch(apiBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            blobUrl: blob.url,
            sizeBytes: file.size,
            mimeType: file.type || null,
            category,
          }),
        });
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`record failed: ${res.status} ${detail}`);
        }
        setUploading((prev) =>
          prev.map((u) => (u.name === file.name ? { ...u, progress: 'done' } : u)),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setUploading((prev) =>
          prev.map((u) => (u.name === file.name ? { ...u, progress: 'error', error: msg } : u)),
        );
        setError(`Upload failed for "${file.name}": ${msg}`);
      }
    }
    // Refresh once after the batch — the list ordering is by
    // uploaded_at DESC server-side so the new entries surface first.
    await refresh();
    // Drop the trackers after a short delay so the user sees the
    // "done" state before the row collapses out.
    window.setTimeout(() => {
      setUploading((prev) => prev.filter((u) => u.progress === 'uploading' || u.progress === 'recording'));
    }, 1500);
  }

  async function handleDelete(documentId: string) {
    if (!window.confirm('Delete this document? This cannot be undone.')) return;
    try {
      const res = await fetch(`${apiBase}/${documentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`${res.status} ${detail}`);
      }
      setDocs((prev) => prev.filter((d) => d.id !== documentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[color:var(--color-foreground)]">
            Documents
          </h2>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            Tenant-scoped attachments for {entityName}. Visible only to your company.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-xs"
            aria-label="Document category"
          >
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-foreground)] hover:opacity-90"
          >
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS.join(',')}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files) void handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-[var(--radius-md)] border border-dashed px-3 py-4 text-center text-xs transition-colors ${
          dragOver
            ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5 text-[color:var(--color-accent)]'
            : 'border-[color:var(--color-border)] bg-[color:var(--color-muted)]/10 text-[color:var(--color-muted-foreground)]'
        }`}
      >
        Drag &amp; drop files here, or click <strong>Upload</strong>. PDF / DOCX / XLSX / TXT / images. Max 100 MB.
      </div>

      {error ? (
        <div className="rounded-[var(--radius-sm)] border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      {uploading.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {uploading.map((u) => (
            <li
              key={u.name}
              className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/15 px-3 py-1.5 text-xs"
            >
              <span className="truncate font-medium">{u.name}</span>
              <span className="text-[color:var(--color-muted-foreground)]">
                {u.progress === 'uploading'
                  ? `Uploading ${formatSize(u.size)}…`
                  : u.progress === 'recording'
                    ? 'Recording…'
                    : u.progress === 'done'
                      ? 'Done'
                      : `Error: ${u.error ?? 'unknown'}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {!loaded ? (
        <div className="text-xs text-[color:var(--color-muted-foreground)]">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-xs text-[color:var(--color-muted-foreground)]">
          No documents yet. Drop files above to attach KYC packs, MSAs, datasheets, etc.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-[color:var(--color-border)]">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <a
                  href={d.blobUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-medium hover:underline"
                  title={d.filename}
                >
                  {d.filename}
                </a>
                <div className="flex items-center gap-2 text-[10px] text-[color:var(--color-muted-foreground)]">
                  {d.category ? (
                    <span className="rounded-full bg-[color:var(--color-muted)]/30 px-1.5 py-0.5 uppercase tracking-wide">
                      {CATEGORY_LABELS[d.category] ?? d.category}
                    </span>
                  ) : null}
                  {d.sizeBytes != null ? <span>{formatSize(d.sizeBytes)}</span> : null}
                  <span>
                    {new Date(d.uploadedAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(d.id)}
                className="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-[color:var(--color-muted-foreground)] hover:bg-red-50 hover:text-red-700"
                aria-label={`Delete ${d.filename}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
