import { extractText as unpdfExtract, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

export type ExtractResult = {
  text: string;
  pageCount: number | null;
  mimeType: string;
};

/**
 * Extract plain text from a downloaded tender attachment.
 *
 * PDFs: unpdf (wrapper over pdfjs-dist) — pure JS, runs in trigger.dev's
 *   Node runtime without native deps. Text-layer PDFs only; scanned
 *   PDFs return empty text and need OCR (not implemented yet).
 * DOCX: mammoth.
 * TXT/MD: utf-8 decode.
 *
 * `urlOrName` is the original URL or filename — used purely for extension
 * sniffing when the response Content-Type is missing or generic
 * (Jamaica GOJEP returns `application/octet-stream` for PDFs).
 */
export async function extractTextFromBuffer(
  buf: Uint8Array,
  contentType: string | undefined,
  urlOrName: string,
): Promise<ExtractResult> {
  const lower = urlOrName.toLowerCase();
  const ct = (contentType ?? '').toLowerCase();

  if (lower.endsWith('.pdf') || ct === 'application/pdf') {
    const pdf = await getDocumentProxy(buf);
    const { text } = await unpdfExtract(pdf, { mergePages: true });
    return {
      text: Array.isArray(text) ? text.join('\n\n') : text,
      pageCount: pdf.numPages,
      mimeType: 'application/pdf',
    };
  }

  if (
    lower.endsWith('.docx') ||
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    return {
      text: value,
      pageCount: null,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md') || ct.startsWith('text/')) {
    return {
      text: new TextDecoder('utf-8').decode(buf),
      pageCount: null,
      mimeType: ct.startsWith('text/') ? ct : 'text/plain',
    };
  }

  throw new Error(
    `Unsupported document type: contentType="${contentType ?? '(none)'}", url="${urlOrName}"`,
  );
}

/**
 * Best-guess file extension for an URL — used to build the R2 key.
 * Falls back to `.bin` so we never store an extension-less object.
 */
export function extensionForUrl(url: string, contentType: string | undefined): string {
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf') || contentType === 'application/pdf') return 'pdf';
  if (
    lower.endsWith('.docx') ||
    contentType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return 'docx';
  if (lower.endsWith('.doc')) return 'doc';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.md')) return 'md';
  return 'bin';
}
