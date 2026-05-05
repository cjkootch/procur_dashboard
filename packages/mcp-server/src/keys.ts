import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  db,
  mcpApiKeys,
  type McpApiKey,
  type NewMcpApiKey,
} from '@procur/db';
import {
  MCP_DISPLAY_SUFFIX_LENGTH,
  MCP_KEY_PREFIX,
  MCP_KEY_RAW_LENGTH,
  loadMcpConfig,
} from './config';

/**
 * Generate a fresh raw key. Format: `procur_mcp_<base64url-32-bytes>`.
 * Prefix is a constant for log-grep / GitHub secret-scanning.
 */
export function generateRawKey(): string {
  const random = randomBytes(MCP_KEY_RAW_LENGTH).toString('base64url');
  return `${MCP_KEY_PREFIX}${random}`;
}

/**
 * Hash a raw key for storage / lookup. Uses sha-256 plus the
 * per-deployment pepper. Throws when the pepper isn't configured —
 * a misconfigured pepper means any persisted hashes become
 * unverifiable, which would be a silent auth bypass risk.
 */
export function hashKey(rawKey: string): string {
  const config = loadMcpConfig();
  if (!config.pepper) {
    throw new Error(
      'MCP_KEY_PEPPER is not configured. Refusing to hash keys without a pepper.',
    );
  }
  return createHash('sha256').update(`${rawKey}${config.pepper}`).digest('hex');
}

export function deriveDisplaySuffix(rawKey: string): string {
  return rawKey.slice(-MCP_DISPLAY_SUFFIX_LENGTH);
}

// ─── Key creation ──────────────────────────────────────────────────

export type CreateMcpApiKeyArgs = {
  companyId: string;
  createdByUserId: string;
  name: string;
};

export type CreateMcpApiKeyResult = {
  /** The raw key. Shown to the operator ONCE; never persisted. */
  rawKey: string;
  /** The persisted row. */
  row: McpApiKey;
};

export async function createMcpApiKey(
  args: CreateMcpApiKeyArgs,
): Promise<CreateMcpApiKeyResult> {
  const rawKey = generateRawKey();
  const insertRow: NewMcpApiKey = {
    keyHash: hashKey(rawKey),
    name: args.name,
    companyId: args.companyId,
    createdByUserId: args.createdByUserId,
    displaySuffix: deriveDisplaySuffix(rawKey),
    status: 'active',
  };
  const [row] = await db.insert(mcpApiKeys).values(insertRow).returning();
  if (!row) {
    throw new Error('Failed to insert mcp_api_keys row.');
  }
  return { rawKey, row };
}

// ─── Key lookup (auth path) ────────────────────────────────────────

/**
 * Resolve an incoming key to its row. Returns null when:
 *   - no row matches the hashed key
 *   - the row's status is anything other than 'active'
 *
 * Callers (the MCP route handler) treat null as auth failure.
 */
export async function findActiveKeyByRaw(rawKey: string): Promise<McpApiKey | null> {
  if (!rawKey.startsWith(MCP_KEY_PREFIX)) return null;
  const keyHash = hashKey(rawKey);
  const rows = await db
    .select()
    .from(mcpApiKeys)
    .where(and(eq(mcpApiKeys.keyHash, keyHash), eq(mcpApiKeys.status, 'active')))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Key management (settings UI) ─────────────────────────────────

export async function listMcpKeysForCompany(companyId: string): Promise<McpApiKey[]> {
  return db
    .select()
    .from(mcpApiKeys)
    .where(eq(mcpApiKeys.companyId, companyId))
    .orderBy(mcpApiKeys.createdAt);
}

export async function revokeMcpApiKey(args: {
  companyId: string;
  keyId: string;
}): Promise<void> {
  await db
    .update(mcpApiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(eq(mcpApiKeys.id, args.keyId), eq(mcpApiKeys.companyId, args.companyId)));
}
