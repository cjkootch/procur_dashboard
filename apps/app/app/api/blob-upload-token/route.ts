import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireCompany } from '@procur/auth';

export const runtime = 'nodejs';

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
];

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Mints a short-lived upload token used by `@vercel/blob/client.upload()`
 * on the upload form. We require the user to be authenticated and
 * company-scoped before issuing a token; without this anyone could
 * upload to our blob store.
 *
 * The pathname comes from the client (we let it choose, but every
 * upload-form path is prefixed `tender-uploads/<uuid>/`). Vercel Blob
 * applies its own path-collision and size enforcement on top of what
 * we declare here.
 */
export async function POST(req: Request): Promise<Response> {
  await requireCompany();

  const body = (await req.json()) as HandleUploadBody;

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_FILE_BYTES,
        // 5 minutes — enough for a 100 MB upload on a slow connection,
        // not so long that a leaked token is dangerous.
        validUntil: Date.now() + 5 * 60 * 1000,
      }),
      onUploadCompleted: async () => {
        // No-op for now. The form's submit action picks up the resulting
        // URL via state and persists rows; nothing to do here.
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload token generation failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
