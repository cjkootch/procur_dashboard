import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, entityDocuments, ENTITY_DOCUMENT_CATEGORIES } from '@procur/db';
import { getCurrentUser, requireCompany } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Per-entity document attachments.
 *
 *   GET  /api/entities/{slug}/documents  → list (newest first)
 *   POST /api/entities/{slug}/documents  → record an upload
 *
 * The actual file upload happens client-side directly to Vercel Blob
 * via the existing /api/blob-upload-token path; this endpoint just
 * records the post-upload metadata so the documents panel can list
 * + delete them. Upload + DB-write split avoids the 4.5 MB serverless
 * body limit on Vercel.
 *
 * Per-tenant scoped on `companies.id` — KYC packs are sensitive,
 * one tenant's docs never surface to another even when both tenants
 * have the same entity in their rolodex.
 */

const PostBodySchema = z.object({
  filename: z.string().min(1).max(512),
  blobUrl: z.string().url(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  mimeType: z.string().min(1).max(255).nullish(),
  category: z.enum(ENTITY_DOCUMENT_CATEGORIES).nullish(),
  description: z.string().max(2000).nullish(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { company } = await requireCompany();
  const { slug } = await params;
  const entitySlug = decodeURIComponent(slug);

  const rows = await db
    .select({
      id: entityDocuments.id,
      filename: entityDocuments.filename,
      blobUrl: entityDocuments.blobUrl,
      sizeBytes: entityDocuments.sizeBytes,
      mimeType: entityDocuments.mimeType,
      category: entityDocuments.category,
      description: entityDocuments.description,
      uploadedBy: entityDocuments.uploadedBy,
      uploadedAt: entityDocuments.uploadedAt,
    })
    .from(entityDocuments)
    .where(
      and(
        eq(entityDocuments.companyId, company.id),
        eq(entityDocuments.entitySlug, entitySlug),
      ),
    )
    .orderBy(desc(entityDocuments.uploadedAt));

  return NextResponse.json({ documents: rows });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { company } = await requireCompany();
  const { slug } = await params;
  const entitySlug = decodeURIComponent(slug);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'unprocessable', detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;

  const [inserted] = await db
    .insert(entityDocuments)
    .values({
      companyId: company.id,
      entitySlug,
      filename: body.filename,
      blobUrl: body.blobUrl,
      sizeBytes: body.sizeBytes ?? null,
      mimeType: body.mimeType ?? null,
      category: body.category ?? null,
      description: body.description ?? null,
      uploadedBy: user.id,
    })
    .returning();

  return NextResponse.json({ document: inserted }, { status: 201 });
}
