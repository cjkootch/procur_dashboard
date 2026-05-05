'use client';

import { useState, useTransition } from 'react';
import { createMcpApiKeyAction } from '../actions';

/**
 * "Generate new key" form. The raw key is returned by the action
 * once and ONLY once — surface it immediately + warn the operator
 * that subsequent reloads won't show it again.
 */
export function CreateMcpKeyForm() {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (rawKey) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-emerald-500/40 bg-emerald-500/5 p-4">
        <p className="text-sm font-medium">Key created. Copy it now — you won&apos;t see it again.</p>
        <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/40 p-3 font-mono text-xs">
          {rawKey}
        </pre>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(rawKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-3 py-1 text-xs font-medium text-[color:var(--color-background)]"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => {
              setRawKey(null);
              setName('');
            }}
            className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--color-muted)]/40"
          >
            Done
          </button>
        </div>
        <p className="mt-3 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          Lost keys can&apos;t be recovered. Generate a new one if you lose this.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await createMcpApiKeyAction({ name });
          if (!result.ok) {
            setError(result.message);
            return;
          }
          setRawKey(result.rawKey);
        });
      }}
      className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4"
    >
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Key name
        </span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Claude Desktop, ChatGPT custom GPT, …"
          className="mt-1 w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1.5 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          maxLength={80}
        />
      </label>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || name.trim().length === 0}
          className="rounded-[var(--radius-md)] border border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-50"
        >
          {pending ? 'Generating…' : 'Generate key'}
        </button>
        {error && (
          <span className="text-xs text-amber-700 dark:text-amber-300">{error}</span>
        )}
      </div>
      <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Each key carries this tenant&apos;s scope. External AI clients (Claude Desktop,
        ChatGPT, Cursor) call procur tools as if they were the in-app assistant for
        this company.
      </p>
    </form>
  );
}
