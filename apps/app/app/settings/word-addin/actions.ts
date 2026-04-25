'use server';

import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db, wordAddinTokens } from '@procur/db';
import { requireCompany } from '@procur/auth';
import {
  generateWordAddinToken,
  WORD_ADDIN_FLASH_COOKIE,
} from '../../../lib/word-addin-tokens';

const FLASH_COOKIE = WORD_ADDIN_FLASH_COOKIE;
const FLASH_TTL_SECONDS = 60;

export async function mintWordAddinTokenAction(formData: FormData): Promise<void> {
  const { user, company } = await requireCompany();
  const rawLabel = String(formData.get('label') ?? '').trim();
  const label = rawLabel.length === 0 ? 'Word add-in' : rawLabel.slice(0, 80);

  const { raw, hash, prefix } = generateWordAddinToken();

  await db.insert(wordAddinTokens).values({
    companyId: company.id,
    userId: user.id,
    label,
    tokenHash: hash,
    tokenPrefix: prefix,
  });

  // One-shot display: set a short-lived cookie so the token is shown once
  // on the very next render of /settings/word-addin and never again.
  // httpOnly so client JS can't read it; the page renders the token in
  // server-rendered HTML.
  const c = await cookies();
  c.set(FLASH_COOKIE, raw, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/settings/word-addin',
    maxAge: FLASH_TTL_SECONDS,
  });

  revalidatePath('/settings/word-addin');
  redirect('/settings/word-addin?minted=1');
}

export async function revokeWordAddinTokenAction(formData: FormData): Promise<void> {
  const { user } = await requireCompany();
  const tokenId = String(formData.get('tokenId') ?? '');
  if (!tokenId) throw new Error('tokenId required');

  // Scope by user so one user can't revoke another user's tokens (even
  // within the same company).
  await db
    .update(wordAddinTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(wordAddinTokens.id, tokenId), eq(wordAddinTokens.userId, user.id)));

  revalidatePath('/settings/word-addin');
}

