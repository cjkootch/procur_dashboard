import { listMcpTools } from '@procur/mcp-server';
import { buildCatalogTools } from '@procur/catalog/tools';

/**
 * Live-rendered list of tools currently exposed via /api/mcp.
 *
 * Reads the same registry + whitelist that the route handler does,
 * so the docs can't silently drift from the runtime surface — adding
 * a tool to the whitelist instantly appears here, removing one
 * disappears.
 */
export function ToolCatalog() {
  const registry = buildCatalogTools();
  const { tools } = listMcpTools(registry);

  if (tools.length === 0) {
    return (
      <p className="text-sm text-[color:var(--color-muted-foreground)]">
        No tools currently whitelisted. (This shouldn&apos;t happen in production.)
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {tools.map((tool) => (
        <details
          key={tool.name}
          className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3"
        >
          <summary className="cursor-pointer">
            <span className="font-mono text-sm">{tool.name}</span>
            <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">
              — {summarizeDescription(tool.description)}
            </span>
          </summary>
          <p className="mt-2 text-xs text-[color:var(--color-muted-foreground)]">
            {tool.description}
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
              Input schema
            </summary>
            <pre className="mt-1 overflow-x-auto rounded-[var(--radius-md)] bg-[color:var(--color-muted)]/30 p-2 text-[11px]">
              {JSON.stringify(tool.inputSchema, null, 2)}
            </pre>
          </details>
        </details>
      ))}
    </div>
  );
}

/**
 * Render the full tool count for the page intro. Live so it stays
 * accurate as the whitelist grows.
 */
export function ToolCatalogCount() {
  const registry = buildCatalogTools();
  const { tools } = listMcpTools(registry);
  return tools.length;
}

function summarizeDescription(description: string): string {
  // First sentence or first 100 chars, whichever is shorter.
  const firstSentence = description.split(/(?<=[.!?])\s+/)[0] ?? description;
  const trimmed = firstSentence.length > 100 ? `${firstSentence.slice(0, 97)}…` : firstSentence;
  return trimmed;
}
