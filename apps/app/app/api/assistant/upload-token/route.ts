import { NextResponse } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { requireCompany } from '@procur/auth';

export const runtime = 'nodejs';

/**
 * Image + PDF only. Office docs (docx, etc.) handled by the capture
 * upload-token endpoint; the chat surface doesn't need them and
 * narrowing the MIME list reduces the abuse surface.
 *
 * Anthropic supports PDF natively as type:'document' content blocks
 * (32MB max upstream); we cap at 20MB to keep payloads sane. Image
 * formats match Anthropic's vision input set.
 */
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Short-lived upload token for chat-attached files. Path prefix
 * `assistant-uploads/<companyId>/<uuid>` keeps these isolated from
 * tender-capture uploads.
 *
 * Auth gate: requireCompany() — every uploader is an authenticated
 * member of a tenant.
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
        validUntil: Date.now() + 5 * 60 * 1000,
      }),
      onUploadCompleted: async () => {
        // No-op. The Chat composer picks up the URL via the
        // upload() callback and includes it in the next message.
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload token generation failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
