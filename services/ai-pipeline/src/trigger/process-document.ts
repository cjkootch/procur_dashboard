import { task } from '@trigger.dev/sdk/v3';
import { eq } from 'drizzle-orm';
import { db, documents } from '@procur/db';
import { fetchWithRetry } from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';
import { uploadBuffer } from '../lib/r2';
import { extensionForUrl, extractTextFromBuffer } from '../lib/extract-text';

export type ProcessDocumentPayload = { documentId: string };

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Download a tender attachment, persist it to R2, extract text, and
 * advance `processing_status` to 'completed'.
 *
 * Triggered by enrich-opportunity for every freshly-scraped pending
 * document, and by the scheduled sweep for any that fell through.
 *
 * Failure modes (status='error', error message persisted):
 *   - URL unreachable / non-2xx after retries
 *   - File >50 MB (Anthropic context + R2 cost guardrail)
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
      const ext = extensionForUrl(doc.originalUrl, contentType);
      const r2Key = `tender-documents/${doc.id}.${ext}`;

      const extracted = await extractTextFromBuffer(buf, contentType, doc.originalUrl);

      const upload = await uploadBuffer(r2Key, buf, extracted.mimeType);

      await db
        .update(documents)
        .set({
          r2Key: upload.key,
          r2Url: upload.url,
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
        r2Key: upload.key,
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
