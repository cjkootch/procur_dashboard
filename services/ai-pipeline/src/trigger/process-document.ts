import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { db, documents } from '@procur/db';
import { fetchWithRetry } from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';
import { uploadBuffer } from '../lib/blob-storage';
import { extensionForUrl, extractTextFromBuffer } from '../lib/extract-text';

export type ProcessDocumentPayload = { documentId: string };

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const VERCEL_BLOB_HOST_RE = /\.public\.blob\.vercel-storage\.com$/;

/**
 * Download a tender attachment, persist it to Vercel Blob, extract
 * text, and advance `processing_status` to 'completed'.
 *
 * Triggered by enrich-opportunity for every freshly-scraped pending
 * document, and by the scheduled sweep for any that fell through.
 *
 * For private uploads, the originalUrl IS already a Vercel Blob URL
 * (the Capture app's upload form writes directly to Blob via
 * @vercel/blob/client). In that case we skip the re-upload step:
 * download from Blob, extract text, and reuse the same URL as the
 * persisted r2Url.
 *
 * Failure modes (status='error', error message persisted):
 *   - URL unreachable / non-2xx after retries
 *   - File >100 MB (Anthropic context + storage cost guardrail)
 *   - Unsupported file type (anything other than PDF/DOCX/TXT/MD)
 *   - Text extraction throws (corrupt PDF, encrypted, etc.)
 *
 * Empty `extracted_text` is NOT a failure — text-layer-less scanned
 * PDFs land here. Status is still flipped to 'completed'; OCR is a
 * follow-up.
 */
export const processDocumentTask = task({
  id: 'document.process',
  maxDuration: 600,
  run: async (payload: ProcessDocumentPayload) => {
    const { documentId } = payload;
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, documentId),
    });
    if (!doc) throw new Error(`document ${documentId} not found`);
    if (doc.processingStatus === 'completed') {
      log.info('document.process.skipped', { documentId, reason: 'already-completed' });
      return { documentId, status: 'completed' as const, skipped: true };
    }

    log.info('document.process.started', {
      documentId,
      url: doc.originalUrl,
    });

    try {
      const res = await fetchWithRetry(doc.originalUrl, {
        timeoutMs: 60_000,
        maxRetries: 3,
      });
      if (!res.ok) {
        throw new Error(`fetch ${doc.originalUrl} returned ${res.status}`);
      }

      const contentLength = Number(res.headers.get('content-length') ?? '0');
      if (contentLength > MAX_FILE_BYTES) {
        throw new Error(
          `file too large: ${contentLength} bytes (limit ${MAX_FILE_BYTES})`,
        );
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_FILE_BYTES) {
        throw new Error(
          `file too large: ${buf.byteLength} bytes (limit ${MAX_FILE_BYTES})`,
        );
      }

      const contentType = res.headers.get('content-type') ?? undefined;
      const extracted = await extractTextFromBuffer(buf, contentType, doc.originalUrl);

      // If the doc was uploaded directly to Vercel Blob by the Capture
      // app (private uploads), originalUrl is already a Blob URL and
      // re-uploading would just duplicate the bytes. Reuse the URL.
      let r2Key: string;
      let r2Url: string;
      try {
        const originHost = new URL(doc.originalUrl).host;
        if (VERCEL_BLOB_HOST_RE.test(originHost)) {
          // pathname starts with '/' — strip it to get the Blob key.
          r2Key = new URL(doc.originalUrl).pathname.replace(/^\//, '');
          r2Url = doc.originalUrl;
        } else {
          const ext = extensionForUrl(doc.originalUrl, contentType);
          const upload = await uploadBuffer(
            `tender-documents/${doc.id}.${ext}`,
            buf,
            extracted.mimeType,
          );
          r2Key = upload.key;
          r2Url = upload.url;
        }
      } catch {
        // URL parse failed for some reason — fall back to upload path.
        const ext = extensionForUrl(doc.originalUrl, contentType);
        const upload = await uploadBuffer(
          `tender-documents/${doc.id}.${ext}`,
          buf,
          extracted.mimeType,
        );
        r2Key = upload.key;
        r2Url = upload.url;
      }

      await db
        .update(documents)
        .set({
          r2Key,
          r2Url,
          extractedText: extracted.text,
          pageCount: extracted.pageCount,
          fileSize: buf.byteLength,
          mimeType: extracted.mimeType,
          processingStatus: 'completed',
          processingError: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));

      log.info('document.process.completed', {
        documentId,
        r2Key,
        bytes: buf.byteLength,
        pages: extracted.pageCount,
        textLen: extracted.text.length,
      });

      return {
        documentId,
        status: 'completed' as const,
        bytes: buf.byteLength,
        pages: extracted.pageCount,
        textLen: extracted.text.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(documents)
        .set({
          processingStatus: 'error',
          processingError: message,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));
      log.error('document.process.failed', { documentId, error: message });
      throw err;
    }
  },
});
