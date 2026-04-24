import 'server-only';
import { extractText as unpdfExtract, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

export type ExtractResult = {
  text: string;
  pageCount: number | null;
};

/**
 * Extract plain text from a PDF or DOCX Buffer.
 *
 * PDFs: unpdf (wrapper over pdfjs-dist). Pure JS, works in serverless.
 * DOCX: mammoth (reliable for .docx only — pre-2007 .doc not supported).
 *
 * Text files (.txt, .md) pass through.
 */
export async function extractTextFromFile(
  file: File,
): Promise<ExtractResult> {
  const name = (file.name ?? '').toLowerCase();
  const type = file.type ?? '';
  const buf = new Uint8Array(await file.arrayBuffer());

  if (name.endsWith('.pdf') || type === 'application/pdf') {
    const pdf = await getDocumentProxy(buf);
    const { text } = await unpdfExtract(pdf, { mergePages: true });
    return {
      text: Array.isArray(text) ? text.join('\n\n') : text,
      pageCount: pdf.numPages,
    };
  }

  if (
    name.endsWith('.docx') ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    return { text: value, pageCount: null };
  }

  if (name.endsWith('.txt') || name.endsWith('.md') || type.startsWith('text/')) {
    const text = new TextDecoder('utf-8').decode(buf);
    return { text, pageCount: null };
  }

  throw new Error(
    `Unsupported file type "${type || name}". Upload PDF, DOCX, TXT, or MD.`,
  );
}
