/**
 * MCP server configuration. Spec: docs/mcp-server-brief.md.
 *
 * Defaults to disabled outside production. Set MCP_ENABLED=true (and
 * provide MCP_KEY_PEPPER) to actually accept connections.
 */

export const MCP_KEY_PREFIX = 'procur_mcp_' as const;
export const MCP_KEY_RAW_LENGTH = 32;
export const MCP_RATE_LIMIT_PER_HOUR = 1000;
export const MCP_DISPLAY_SUFFIX_LENGTH = 4;

export type McpConfig = {
  enabled: boolean;
  /** Per-deployment pepper used in key hashing. Hashes computed
   *  with one pepper aren't valid against another, so rotating the
   *  pepper effectively revokes all keys. Required when
   *  MCP_ENABLED=true. */
  pepper: string | null;
};

export function loadMcpConfig(): McpConfig {
  return {
    enabled: process.env.MCP_ENABLED === 'true',
    pepper: process.env.MCP_KEY_PEPPER ?? null,
  };
}
