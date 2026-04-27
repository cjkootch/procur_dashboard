import { NextResponse } from 'next/server';
import { requireCompany } from '@procur/auth';
import { getClient, MODELS } from '@procur/ai';
import { extractTextFromFile } from '../../../lib/extract-text';

export const runtime = 'nodejs';
export const maxDuration = 60;

const VERCEL_BLOB_HOST_RE = /\.public\.blob\.vercel-storage\.com$/;

/**
 * Best-effort metadata pre-fill. Downloads the uploaded PDF, extracts
 * the first ~3 pages of text, and asks Haiku to identify the title,
 * agency/customer, and submission deadline. The form treats this as a
 * suggestion — user can edit before submitting.
 *
 * Failures are silent (the form falls back to a blank form). We never
 * block the upload flow on this route.
 */
export async function POST(req: Request): Promise<Response> {
  await requireCompany();

  let blobUrl: string;
  try {
    const body = (await req.json()) as { blobUrl?: unknown };
    if (typeof body.blobUrl !== 'string') {
      return NextResponse.json({ error: 'blobUrl required' }, { status: 400 });
    }
    blobUrl = body.blobUrl;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  // Defense in depth: only fetch from our own blob store.
  let host: string;
  try {
    host = new URL(blobUrl).host;
  } catch {
    return NextResponse.json({ error: 'invalid url' }, { status: 400 });
  }
  if (!VERCEL_BLOB_HOST_RE.test(host)) {
    return NextResponse.json({ error: 'unsupported url' }, { status: 400 });
  }

  try {
    const res = await fetch(blobUrl);
    if (!res.ok) {
      return NextResponse.json({ error: `fetch ${res.status}` }, { status: 502 });
    }
    const buffer = await res.arrayBuffer();
    const file = new File([buffer], 'upload.pdf', { type: 'application/pdf' });
    const { text } = await extractTextFromFile(file);

    // Cap at ~12k chars (~3000 tokens) — keeps the Haiku call snappy
    // and well inside model limits. Most RFP front matter (title,
    // agency, deadline) fits in the first 1-2 pages, well within this.
    const excerpt = text.slice(0, 12_000);
    if (excerpt.trim().length < 50) {
      // Probably a scanned PDF (no text layer) or an image-heavy doc.
      // Auto-suggest can't help here.
      return NextResponse.json({});
    }

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 400,
      system:
        'You are extracting bid/RFP metadata from the first few pages of a procurement document. Return STRICT JSON with keys: title (the solicitation title), agency (the issuing agency or customer organization), deadline (submission deadline as YYYY-MM-DD if visible, else null). Use null for any field you cannot find with high confidence. No prose before or after the JSON.',
      messages: [
        {
          role: 'user',
          content: `Extract the metadata from this document excerpt:\n\n---\n${excerpt}\n---`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return NextResponse.json({});

    const json = parseJson(block.text);
    if (!json) return NextResponse.json({});

    return NextResponse.json({
      title: typeof json.title === 'string' ? json.title.slice(0, 500) : undefined,
      agency: typeof json.agency === 'string' ? json.agency.slice(0, 200) : undefined,
      deadline:
        typeof json.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(json.deadline)
          ? json.deadline
          : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'auto-suggest failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseJson(s: string): Record<string, unknown> | null {
  // Haiku sometimes wraps in ```json fences despite the prompt; strip
  // them defensively.
  const cleaned = s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
