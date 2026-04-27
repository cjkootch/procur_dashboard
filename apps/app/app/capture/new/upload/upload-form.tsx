'use client';

import { upload } from '@vercel/blob/client';
import { useRef, useState, useTransition } from 'react';
import { Button, Card, Input, Label } from '@procur/ui';
import { createPrivatePursuitFromUploadAction } from './actions';

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md'];

type UploadedFile = {
  name: string;
  size: number;
  url: string;
};

type Suggestion = {
  title?: string;
  agency?: string;
  deadline?: string;
};

export function UploadForm() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploadingNames, setUploadingNames] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [agency, setAgency] = useState('');
  const [deadline, setDeadline] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const allDoneUploading = uploadingNames.size === 0;
  const canSubmit = files.length > 0 && title.trim().length > 0 && allDoneUploading && !isPending;

  async function handleFiles(picked: FileList | File[]) {
    setError(null);
    const list = Array.from(picked);

    for (const file of list) {
      const lower = file.name.toLowerCase();
      const ok = ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
      if (!ok) {
        setError(`"${file.name}" — unsupported file type. Upload PDF, DOCX, TXT, or MD.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`"${file.name}" is ${formatSize(file.size)} (max 100 MB).`);
        continue;
      }

      setUploadingNames((prev) => new Set(prev).add(file.name));
      try {
        const blob = await upload(`tender-uploads/${crypto.randomUUID()}/${file.name}`, file, {
          access: 'public',
          // We hit a server route to mint a short-lived token; client.upload
          // sends the file directly to Vercel Blob without going through
          // our serverless function (which has a 4.5MB body limit).
          handleUploadUrl: '/api/blob-upload-token',
        });
        setFiles((prev) => [...prev, { name: file.name, size: file.size, url: blob.url }]);

        // First successful PDF upload → kick off Haiku metadata
        // auto-suggest. Fire and forget; user can edit before submit.
        if (suggestion === null && file.name.toLowerCase().endsWith('.pdf')) {
          fetch('/api/upload-suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ blobUrl: blob.url }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((s: Suggestion | null) => {
              if (!s) return;
              setSuggestion(s);
              if (s.title && !title) setTitle(s.title);
              if (s.agency && !agency) setAgency(s.agency);
              if (s.deadline && !deadline) setDeadline(s.deadline);
            })
            .catch(() => {
              /* best-effort — silent */
            });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Upload failed for "${file.name}": ${msg}`);
      } finally {
        setUploadingNames((prev) => {
          const next = new Set(prev);
          next.delete(file.name);
          return next;
        });
      }
    }
  }

  function removeFile(url: string) {
    setFiles((prev) => prev.filter((f) => f.url !== url));
  }

  function onSubmit(formData: FormData) {
    if (!canSubmit) return;
    for (const f of files) formData.append('blobUrls', f.url);
    for (const f of files) formData.append('blobNames', f.name);
    startTransition(async () => {
      try {
        await createPrivatePursuitFromUploadAction(formData);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    });
  }

  return (
    <form action={onSubmit} className="space-y-5">
      <DropZone
        onFiles={handleFiles}
        onClick={() => fileInputRef.current?.click()}
        empty={files.length === 0}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {(files.length > 0 || uploadingNames.size > 0) && (
        <Card padding="md">
          <Label as="div" className="mb-2">
            Documents ({files.length + uploadingNames.size})
          </Label>
          <ul className="space-y-1.5">
            {files.map((f) => (
              <li key={f.url} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  ✓ {f.name}{' '}
                  <span className="text-[color:var(--color-muted-foreground)]">
                    ({formatSize(f.size)})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(f.url)}
                  className="text-xs text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:underline"
                >
                  Remove
                </button>
              </li>
            ))}
            {Array.from(uploadingNames).map((name) => (
              <li key={name} className="text-sm text-[color:var(--color-muted-foreground)]">
                <span className="inline-block animate-pulse">●</span> Uploading {name}…
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Title *</span>
          <Input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Cloud Migration Services for the Department of Health"
            required
          />
          {suggestion?.title && suggestion.title === title && (
            <span className="mt-1 inline-block text-xs text-[color:var(--color-muted-foreground)]">
              ↳ Suggested from PDF
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Agency / Customer</span>
          <Input
            name="agency"
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
            placeholder="e.g. U.S. Department of Veterans Affairs"
          />
          {suggestion?.agency && suggestion.agency === agency && (
            <span className="mt-1 inline-block text-xs text-[color:var(--color-muted-foreground)]">
              ↳ Suggested from PDF
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Submission deadline</span>
          <Input
            name="deadline"
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
          {suggestion?.deadline && suggestion.deadline === deadline && (
            <span className="mt-1 inline-block text-xs text-[color:var(--color-muted-foreground)]">
              ↳ Suggested from PDF
            </span>
          )}
        </label>
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => history.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {isPending ? 'Creating…' : 'Create pursuit'}
        </Button>
      </div>
    </form>
  );
}

function DropZone({
  onFiles,
  onClick,
  empty,
}: {
  onFiles: (files: FileList | File[]) => void;
  onClick: () => void;
  empty: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onClick={onClick}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={
        'flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-lg)] border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30 ' +
        (over
          ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-muted)]/40'
          : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]/50')
      }
    >
      <p className="text-sm font-medium">
        {empty ? 'Drop PDFs here, or click to browse' : 'Add more files'}
      </p>
      <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
        PDF, DOCX, TXT, or MD · up to 100 MB each
      </p>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
