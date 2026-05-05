import Link from 'next/link';
import { HostConfigSnippets } from '../../settings/integrations/mcp/_components/HostConfigSnippets';
import { ToolCatalog, ToolCatalogCount } from './_components/ToolCatalog';

/**
 * Public docs at /docs/mcp — operator + indie-developer reference
 * for connecting external AI hosts to procur.
 *
 * No AppShell, no auth gate. Middleware whitelists /docs/(.*).
 * Tool list renders live from the runtime whitelist so the
 * documentation can't silently drift from what the server actually
 * exposes.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Procur MCP — Connect Claude, ChatGPT, Cursor, Continue',
  description:
    "Connect any MCP-compatible AI host to procur's catalog of buyers, " +
    'sellers, refineries, and market intelligence with a per-tenant API key.',
};

export default function McpDocsPage() {
  const toolCount = ToolCatalogCount();

  return (
    <article className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          Procur MCP integration
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Connect any AI host to procur
        </h1>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Procur exposes a Model Context Protocol (MCP) server so Claude Desktop,
          Cursor, Continue.dev, ChatGPT custom GPTs, and any other MCP-compatible
          host can call procur&apos;s catalog tools as native tools — same
          tenant-scoped view your in-app assistant uses.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Endpoints</h2>
        <table className="w-full table-auto border border-[color:var(--color-border)] text-sm">
          <thead>
            <tr className="bg-[color:var(--color-muted)]/30 text-left text-xs uppercase tracking-wide">
              <th className="border-b border-[color:var(--color-border)] px-3 py-2">
                Use case
              </th>
              <th className="border-b border-[color:var(--color-border)] px-3 py-2">
                URL
              </th>
              <th className="border-b border-[color:var(--color-border)] px-3 py-2">
                Tool surface
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border-b border-[color:var(--color-border)] px-3 py-2">
                General (Claude / Cursor / Continue)
              </td>
              <td className="border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-xs">
                /api/mcp
              </td>
              <td className="border-b border-[color:var(--color-border)] px-3 py-2">
                Curated catalog tools
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2">ChatGPT custom GPTs / Deep Research</td>
              <td className="px-3 py-2 font-mono text-xs">/api/mcp/chatgpt</td>
              <td className="px-3 py-2">
                <code>search</code> + <code>fetch</code>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Authentication</h2>
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          Per-tenant API keys, generated from{' '}
          <Link
            href="/settings/integrations/mcp"
            className="underline hover:text-[color:var(--color-foreground)]"
          >
            /settings/integrations/mcp
          </Link>
          . Keys carry the issuing tenant&apos;s scope; every tool call executes
          with the same tenant filter the in-app assistant uses. No cross-tenant
          data ever flows out.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-3 font-mono text-xs">
{`Authorization: Bearer procur_mcp_<your-key>`}
        </pre>
        <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
          Keys are sha-256 + per-deployment-pepper hashed at rest. The raw key is
          shown once at creation; lost keys can&apos;t be recovered. Revoke and
          re-generate if compromised.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Connection guides</h2>
        <HostConfigSnippets />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">
          Available tools{' '}
          <span className="text-sm font-normal text-[color:var(--color-muted-foreground)]">
            ({toolCount})
          </span>
        </h2>
        <p className="mb-3 text-sm text-[color:var(--color-muted-foreground)]">
          Read-only catalog tools served at <code>/api/mcp</code>. Click a tool to
          expand its description; click <em>Input schema</em> for the JSON Schema
          the model sees.
        </p>
        <ToolCatalog />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">ChatGPT search + fetch</h2>
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          ChatGPT custom GPTs and OpenAI Deep Research require an MCP server
          exposing exactly two tools — <code>search</code> and <code>fetch</code>{' '}
          — with a fixed response shape. The{' '}
          <code>/api/mcp/chatgpt</code> endpoint provides this wrapper.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-3 font-mono text-xs">
{`search({ query: string })
  -> { results: [{ id, title, url }] }

fetch({ id: string })
  -> { id, title, text, url, metadata? }`}
        </pre>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Resource IDs follow the format <code>entity:&lt;slug&gt;</code>. ChatGPT
          uses <code>search</code> to find candidate procur entities, then{' '}
          <code>fetch</code> to pull the full profile.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Tenancy &amp; safety</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[color:var(--color-muted-foreground)]">
          <li>Every tool call carries the issuing key&apos;s tenant scope; cross-tenant queries are impossible.</li>
          <li>Per-key rate limit of 1,000 calls/hour. Exceeding returns JSON-RPC error code <code>-32002</code>.</li>
          <li>Every call (success or failure) writes a row to <code>mcp_tool_call_log</code> with outcome, duration, and host identifier.</li>
          <li>Revoking a key from settings rejects all subsequent calls instantly. The key row stays for audit attribution.</li>
          <li>Validation failures return as <code>isError: true</code> text content so the calling LLM can self-correct.</li>
          <li>Handler exceptions surface a generic message; full error captured in the call log only.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">What&apos;s NOT exposed</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[color:var(--color-muted-foreground)]">
          <li>
            <strong>Write tools</strong> — <code>set_supplier_approval</code>,{' '}
            <code>attach_document_to_entity</code>, <code>add_to_pursuit_pipeline</code>,{' '}
            <code>create_alert_profile</code>. v1 is read-only.
          </li>
          <li>
            <strong>The proposal composer</strong> —{' '}
            <code>compose_proposal_skeleton</code>. Tightly coupled to the in-app
            system-prompt discipline that surfaces counsel-validation gaps; not
            reproducible over MCP yet.
          </li>
          <li>
            <strong>Apollo paid enrichment</strong> — <code>/people/match</code>{' '}
            and <code>/people/bulk_match</code>. These require explicit operator
            confirmation per Apollo&apos;s per-tenant per-day cap discipline.
          </li>
          <li>
            <strong>Heavy pricer tools</strong> —{' '}
            <code>evaluate_target_price</code>, <code>compose_deal_economics</code>.
            Their results need follow-up reasoning the in-app assistant
            provides; surfacing them naked over MCP would mislead.
          </li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Get a key</h2>
        <p className="text-sm text-[color:var(--color-muted-foreground)]">
          Sign in and visit{' '}
          <Link
            href="/settings/integrations/mcp"
            className="underline hover:text-[color:var(--color-foreground)]"
          >
            /settings/integrations/mcp
          </Link>{' '}
          to generate a key. The settings page shows the same connection guides
          with your key inlined.
        </p>
      </section>
    </article>
  );
}
