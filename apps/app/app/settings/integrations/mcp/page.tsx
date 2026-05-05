import { requireCompany } from '@procur/auth';
import { listMcpKeysForCompany, MCP_KEY_PREFIX } from '@procur/mcp-server';
import { CreateMcpKeyForm } from './_components/CreateKeyForm';
import { RevokeKeyButton } from './_components/RevokeKeyButton';

export const dynamic = 'force-dynamic';

const MCP_ENDPOINT_URL = 'https://app.procur.app/api/mcp';

export default async function McpIntegrationPage() {
  const { company } = await requireCompany();
  const keys = await listMcpKeysForCompany(company.id);
  const activeKeys = keys.filter((k) => k.status === 'active');
  const revokedKeys = keys.filter((k) => k.status === 'revoked');

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">MCP integration</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Connect Claude Desktop, ChatGPT custom GPTs, Cursor, Continue.dev — any
          MCP-compatible AI host — to procur. Each key carries this tenant&apos;s
          scope, so external clients see the same view your in-app assistant does.
        </p>
      </header>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Endpoint URL
        </h2>
        <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/20 p-2 font-mono text-xs">
          {MCP_ENDPOINT_URL}
        </pre>
        <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          The endpoint will start serving MCP traffic once the Day 2 build lands.
          Generate keys now so you&apos;re ready to connect when it ships.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Generate new key
        </h2>
        <CreateMcpKeyForm />
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Active keys{' '}
          <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
            ({activeKeys.length})
          </span>
        </h2>
        {activeKeys.length === 0 ? (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            No active keys. Generate one above to start connecting external AI hosts.
          </p>
        ) : (
          <div className="space-y-2">
            {activeKeys.map((k) => (
              <div
                key={k.id}
                className="flex items-start justify-between gap-3 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-[color:var(--color-muted-foreground)]">
                    {MCP_KEY_PREFIX}…{k.displaySuffix}
                  </p>
                  <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
                    {k.totalCalls.toLocaleString()} calls
                    {k.lastUsedAt
                      ? ` · last used ${formatRelative(k.lastUsedAt)}`
                      : ' · never used'}
                    {' · created '}
                    {formatRelative(k.createdAt)}
                  </p>
                </div>
                <RevokeKeyButton keyId={k.id} keyName={k.name} />
              </div>
            ))}
          </div>
        )}
      </section>

      {revokedKeys.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
            Revoked keys{' '}
            <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
              ({revokedKeys.length})
            </span>
          </h2>
          <div className="space-y-2">
            {revokedKeys.map((k) => (
              <div
                key={k.id}
                className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3 opacity-60"
              >
                <p className="text-sm font-medium line-through">{k.name}</p>
                <p className="mt-0.5 font-mono text-xs text-[color:var(--color-muted-foreground)]">
                  {MCP_KEY_PREFIX}…{k.displaySuffix} · revoked
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          What gets exposed
        </h2>
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          A curated set of ~22 read-only catalog tools — rolodex queries, market
          intelligence, crude-grade analytics, deal-structure templates, and Apollo
          discovery. Write tools, the proposal composer, and Apollo paid enrichment
          are deliberately not exposed in v1.
        </p>
        <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          Connection guides for Claude Desktop, ChatGPT custom GPT, Cursor, and
          Continue.dev land alongside the Day 2 build.
        </p>
      </section>
    </div>
  );
}

function formatRelative(d: Date): string {
  const elapsed = Date.now() - d.getTime();
  const days = Math.floor(elapsed / (24 * 60 * 60 * 1000));
  if (days < 1) {
    const hours = Math.floor(elapsed / (60 * 60 * 1000));
    return hours < 1 ? 'just now' : `${hours}h ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
