import { NextResponse } from 'next/server';
import { requireCompany } from '@procur/auth';
import {
  reactivateRvmAudioAsset,
  retireRvmAudioAsset,
} from '@procur/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/rvm/audio-assets/[id]   — retire (is_active = false)
 * POST   /api/rvm/audio-assets/[id]   — body { action: 'reactivate' }
 *
 * "Delete" is a soft retire — the row stays for audit history. The
 * blob in Vercel storage is NOT deleted; another active asset can
 * still reference an old recording if operator wants to compare.
 *
 * Reactivation enforces the single-active-per-scope invariant: any
 * currently-active asset for the same (probe, variant, language)
 * gets retired before this one becomes active. Single transaction
 * in the catalog helper.
 */

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireCompany();
  const { id } = await context.params;
  await retireRvmAudioAsset(id);
  return NextResponse.json({ ok: true });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireCompany();
  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== 'reactivate') {
    return NextResponse.json(
      { error: 'expected body { action: "reactivate" }' },
      { status: 400 },
    );
  }
  await reactivateRvmAudioAsset(id);
  return NextResponse.json({ ok: true });
}
