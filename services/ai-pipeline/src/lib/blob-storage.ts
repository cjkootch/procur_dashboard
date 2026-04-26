import { put } from '@vercel/blob';

export type UploadResult = { key: string; url: string };

/**
 * Upload a buffer to Vercel Blob and return the resolved public URL.
 *
 * Vercel Blob auto-provides BLOB_READ_WRITE_TOKEN to functions deployed
 * on Vercel. For trigger.dev, set the token manually in the project's
 * environment variables (Project → Settings → Environment Variables).
 *
 * `addRandomSuffix: false` keeps keys stable (we use the document UUID),
 * so re-uploads of the same document overwrite cleanly. Without this
 * flag, Vercel Blob appends a random suffix to every upload to prevent
 * accidental collisions — useful for user uploads, not for our content-
 * addressable PDFs.
 */
export async function uploadBuffer(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<UploadResult> {
  // @vercel/blob's put() accepts Buffer/Blob/Readable but not raw Uint8Array.
  // Wrap once here so callers can stay generic.
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  // addRandomSuffix lets reprocessing the same documentId succeed without
  // a BlobAlreadyExistsError. We persist the resulting URL to the docs
  // row, so the random part doesn't matter — we never need to derive the
  // URL from the documentId after the fact.
  const blob = await put(key, buf, {
    access: 'public',
    contentType,
    addRandomSuffix: true,
  });
  return { key: blob.pathname, url: blob.url };
}
