import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { del as deleteBlob } from '@vercel/blob';
import { db, entityDocuments } from '@procur/db';
import { getCurrentUser, requireCompany } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/entities/{slug}/documents/{documentId}
 *
 * Removes the row + the underlying Vercel Blob. Best-effort on the
 * blob delete (logged on failure but not surfaced) — orphaned blobs
 * are recoverable via the Vercel Blob console; orphaned DB rows
 * after a half-completed delete are the worse failure mode.
 *
 * Tenant-scoped on `companies.id`. A document not owned by the
 * caller's company returns 404, not 403, so we don't leak existence.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; documentId: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { company } = await requireCompany();
  const { slug, documentId } = await params;
  const entitySlug = decodeURIComponent(slug);

  const [target] = await db
    .select({ id: entityDocuments.id, blobUrl: entityDocuments.blobUrl })
    .from(entityDocuments)
    .where(
      and(
        eq(entityDocuments.id, documentId),
        eq(entityDocuments.companyId, company.id),
        eq(entityDocuments.entitySlug, entitySlug),
      ),
    )
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Delete the DB row first — if it succeeds and the blob delete
  // fails, the orphan is recoverable. The reverse order (blob first)
  // can leave a row pointing at a 404 URL with no way back.
  await db.delete(entityDocuments).where(eq(entityDocuments.id, target.id));

  try {
    await deleteBlob(target.blobUrl);
  } catch (err) {
    console.warn(
      `[entity-documents] failed to delete blob ${target.blobUrl}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return NextResponse.json({ ok: true });
}
