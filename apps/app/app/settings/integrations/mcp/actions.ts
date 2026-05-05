'use server';

import { revalidatePath } from 'next/cache';
import { requireCompany } from '@procur/auth';
import {
  createMcpApiKey,
  revokeMcpApiKey,
} from '@procur/mcp-server';

export type CreateMcpApiKeyResultClient =
  | { ok: true; rawKey: string; keyId: string }
  | { ok: false; message: string };

/**
 * Create a new MCP API key for the current tenant. Returns the raw
 * key ONCE — caller must surface it in the UI immediately because
 * we never persist or recover the raw value.
 */
export async function createMcpApiKeyAction(input: {
  name: string;
}): Promise<CreateMcpApiKeyResultClient> {
  const trimmed = input.name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Key name is required.' };
  }
  if (trimmed.length > 80) {
    return { ok: false, message: 'Key name must be 80 characters or fewer.' };
  }
  const { company, user } = await requireCompany();
  try {
    const { rawKey, row } = await createMcpApiKey({
      companyId: company.id,
      createdByUserId: user.id,
      name: trimmed,
    });
    revalidatePath('/settings/integrations/mcp');
    return { ok: true, rawKey, keyId: row.id };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Could not create the key. Try again or contact support.',
    };
  }
}

export async function revokeMcpApiKeyAction(input: {
  keyId: string;
}): Promise<{ ok: boolean; message?: string }> {
  const { company } = await requireCompany();
  try {
    await revokeMcpApiKey({ companyId: company.id, keyId: input.keyId });
    revalidatePath('/settings/integrations/mcp');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Revoke failed.',
    };
  }
}
