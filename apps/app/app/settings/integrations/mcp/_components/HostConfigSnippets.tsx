'use client';

import { useState } from 'react';

/**
 * Per-host MCP config snippets. Spec: docs/mcp-server-brief.md §6.
 *
 * Renders the config formats for each AI host the operator might
 * connect from. The `apiKey` prop is `null` after page reload —
 * we never persist raw keys — so the snippets show a `<your key>`
 * placeholder. When called from the post-generation success state,
 * the raw key is embedded directly so operators can copy-and-go
 * without retyping.
 *
 * Vex MCP gotcha applied: Claude Desktop doesn't inherit shell PATH
 * for stdio-launched servers, but procur is HTTP-only — operators
 * use mcp-remote (the official Anthropic bridge) which is
 * self-contained via npx, so the PATH problem doesn't apply here.
 * If/when we ship a stdio bridge, the bridge config note becomes
 * relevant.
 */

const ENDPOINT_URL = 'https://app.procur.app/api/mcp';

const HOSTS = [
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'continue', label: 'Continue.dev' },
] as const;

type HostId = (typeof HOSTS)[number]['id'];

export function HostConfigSnippets({ apiKey }: { apiKey?: string | null }) {
  const [host, setHost] = useState<HostId>('claude-desktop');

  const keyPlaceholder = apiKey ?? '<your-procur-mcp-key>';
  const snippet = renderSnippet(host, keyPlaceholder);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-4">
      <nav className="mb-3 flex flex-wrap gap-1">
        {HOSTS.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => setHost(h.id)}
            className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wide ${
              host === h.id
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
            }`}
          >
            {h.label}
          </button>
        ))}
      </nav>

      <p className="mb-2 text-xs text-[color:var(--color-muted-foreground)]">
        {pathHint(host)}
      </p>

      <div className="relative">
        <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-3 font-mono text-[11px]">
          {snippet}
        </pre>
        <CopyButton text={snippet} />
      </div>

      {!apiKey && (
        <p className="mt-3 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          Replace <code>&lt;your-procur-mcp-key&gt;</code> with the raw key from the
          Generate flow above. Lost keys can&apos;t be recovered — generate a new one
          if you need it.
        </p>
      )}

      {host === 'claude-desktop' && (
        <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          Restart Claude Desktop after editing the config file. The procur tools
          appear in the tool picker once it reconnects.
        </p>
      )}
    </div>
  );
}

function pathHint(host: HostId): string {
  switch (host) {
    case 'claude-desktop':
      return 'Add to ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows).';
    case 'cursor':
      return 'Add to ~/.cursor/mcp.json or .cursor/mcp.json in the workspace root.';
    case 'continue':
      return 'Add to ~/.continue/config.yaml under the mcpServers key.';
  }
}

function renderSnippet(host: HostId, key: string): string {
  switch (host) {
    case 'claude-desktop':
      return JSON.stringify(
        {
          mcpServers: {
            procur: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                ENDPOINT_URL,
                '--header',
                `Authorization: Bearer ${key}`,
              ],
            },
          },
        },
        null,
        2,
      );
    case 'cursor':
      return JSON.stringify(
        {
          mcpServers: {
            procur: {
              url: ENDPOINT_URL,
              headers: {
                Authorization: `Bearer ${key}`,
              },
            },
          },
        },
        null,
        2,
      );
    case 'continue':
      return [
        'mcpServers:',
        '  - name: procur',
        `    url: ${ENDPOINT_URL}`,
        '    headers:',
        `      Authorization: Bearer ${key}`,
      ].join('\n');
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="absolute right-2 top-2 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide hover:bg-[color:var(--color-muted)]/40"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
