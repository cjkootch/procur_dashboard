import {
  db,
  mcpToolCallLog,
  type NewMcpToolCallLogEntry,
} from '@procur/db';

export type LogMcpCallArgs = {
  apiKeyId?: string;
  companyId?: string;
  toolName: string;
  outcome:
    | 'success'
    | 'tool_error'
    | 'auth_failed'
    | 'rate_limited'
    | 'tool_not_whitelisted'
    | 'invalid_input';
  durationMs?: number;
  argsHash?: string;
  errorMessage?: string;
  hostIdentifier?: string;
};

/**
 * Append-only log of MCP tool calls. Mirrors apollo_credit_log.
 *
 * Every MCP request — success or failure — gets a row so abuse
 * detection + observability dashboards see the full picture.
 * The auth-failed and rate-limited rows have `apiKeyId = NULL`
 * (we couldn't resolve the key) and `companyId = NULL`.
 */
export async function logMcpCall(args: LogMcpCallArgs): Promise<void> {
  const row: NewMcpToolCallLogEntry = {
    apiKeyId: args.apiKeyId ?? null,
    companyId: args.companyId ?? null,
    toolName: args.toolName,
    outcome: args.outcome,
    durationMs: args.durationMs ?? null,
    argsHash: args.argsHash ?? null,
    errorMessage: args.errorMessage ?? null,
    hostIdentifier: args.hostIdentifier ?? null,
  };
  await db.insert(mcpToolCallLog).values(row);
}
