import {
  getEntityProfile,
  lookupKnownEntities,
  type EntityProfileResult,
} from '@procur/catalog';
import {
  handleChatgptMcpRequest,
  type ChatgptFetchProvider,
  type ChatgptSearchProvider,
} from '@procur/mcp-server';

/**
 * ChatGPT custom GPT MCP endpoint per docs/mcp-server-brief.md.
 *
 * ChatGPT (and OpenAI Deep Research) require an MCP server that
 * exposes EXACTLY two tools — `search` and `fetch` — with specific
 * response shapes. Procur's general /api/mcp endpoint exposes the
 * curated catalog tools by their original names, which is incompatible
 * with ChatGPT's contract. This route is the ChatGPT-shaped wrapper.
 *
 * Resource ID format: `entity:<slug-or-uuid>`. The prefix lets us
 * extend to other resource types later (awards, commodities, etc.)
 * without ambiguity.
 *
 * Auth + rate limit + log discipline are identical to the general
 * endpoint — same per-tenant API keys.
 */

export const dynamic = 'force-dynamic';

const SERVER_VERSION = '0.0.0';
const ENTITY_ID_PREFIX = 'entity:';
const ENTITY_BASE_URL = 'https://app.procur.app/entities';

const search: ChatgptSearchProvider = async ({ query, companyId }) => {
  // The lookupKnownEntities query handles substring + alias matching.
  // companyId is passed for tenant-scoped approval-state filtering;
  // ChatGPT search results don't surface approval state but the
  // tenant scope keeps cross-tenant data leakage impossible.
  const rows = await lookupKnownEntities({ name: query, companyId, limit: 10 });
  return rows.map((row) => ({
    id: `${ENTITY_ID_PREFIX}${row.slug}`,
    title: row.name,
    url: `${ENTITY_BASE_URL}/${encodeURIComponent(row.slug)}`,
  }));
};

const fetchHandler: ChatgptFetchProvider = async ({ id }) => {
  if (!id.startsWith(ENTITY_ID_PREFIX)) return null;
  const slug = id.slice(ENTITY_ID_PREFIX.length);
  const profile = await getEntityProfile(slug);
  if (profile.primarySource === 'not_found') return null;
  return {
    id,
    title: profile.name,
    text: formatProfileText(profile),
    url: `${ENTITY_BASE_URL}/${encodeURIComponent(profile.canonicalKey)}`,
    metadata: {
      country: profile.country ?? null,
      role: profile.role ?? null,
      categories: profile.categories,
      tags: profile.tags,
      aliases: profile.aliases,
      hasPublicTenderHistory: profile.publicTenderActivity != null,
    },
  };
};

export async function GET(request: Request): Promise<Response> {
  return handleChatgptMcpRequest({
    request,
    search,
    fetch: fetchHandler,
    serverVersion: SERVER_VERSION,
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleChatgptMcpRequest({
    request,
    search,
    fetch: fetchHandler,
    serverVersion: SERVER_VERSION,
  });
}

/**
 * Render an entity profile as plain text for ChatGPT's `fetch.text`
 * field. Keeps the structure scannable so the model can summarize
 * or reason over individual sections.
 */
function formatProfileText(profile: EntityProfileResult): string {
  const lines: string[] = [];
  lines.push(`# ${profile.name}`);
  if (profile.country) lines.push(`Country: ${profile.country}`);
  if (profile.role) lines.push(`Role: ${profile.role}`);
  if (profile.categories.length > 0) {
    lines.push(`Categories: ${profile.categories.join(', ')}`);
  }
  if (profile.tags.length > 0) {
    lines.push(`Tags: ${profile.tags.join(', ')}`);
  }
  if (profile.aliases.length > 0) {
    lines.push(`Aliases: ${profile.aliases.join(', ')}`);
  }
  if (profile.capabilities.capacityBpd != null) {
    lines.push(`Refining capacity: ${profile.capabilities.capacityBpd.toLocaleString()} bpd`);
  }
  if (profile.capabilities.operator) {
    lines.push(`Operator: ${profile.capabilities.operator}`);
  }
  if (profile.capabilities.owner) {
    lines.push(`Owner: ${profile.capabilities.owner}`);
  }
  if (profile.capabilities.inceptionYear) {
    lines.push(`Founded: ${profile.capabilities.inceptionYear}`);
  }
  if (profile.latitude != null && profile.longitude != null) {
    lines.push(`Location: ${profile.latitude.toFixed(4)}, ${profile.longitude.toFixed(4)}`);
  }
  if (profile.publicTenderActivity) {
    const a = profile.publicTenderActivity;
    lines.push('');
    lines.push('## Public-tender activity');
    lines.push(`Total awards: ${a.totalAwards}`);
    if (a.totalValueUsd != null) {
      lines.push(`Total value: $${a.totalValueUsd.toLocaleString()}`);
    }
    if (a.firstAwardDate) lines.push(`First award: ${a.firstAwardDate}`);
    if (a.mostRecentAwardDate) lines.push(`Most recent: ${a.mostRecentAwardDate}`);
  }
  if (profile.notes) {
    lines.push('');
    lines.push('## Notes');
    lines.push(profile.notes);
  }
  return lines.join('\n');
}
