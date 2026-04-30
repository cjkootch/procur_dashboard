/**
 * Minimal RSS 2.0 / Atom parser. Avoids adding `rss-parser` / `feedparser`
 * to the workspace — every feed we ingest emits standard RSS 2.0 or Atom
 * with predictable item shape, and a self-contained extractor is roughly
 * 80 lines.
 *
 * Returns a normalized list of items. Bad / non-feed payloads return [].
 *
 * Not a generic RFC-compliant parser. Don't use for feeds outside the
 * curated FEED_SOURCES list without verifying the shape first.
 */
export type RawFeedItem = {
  /** RSS <guid> or Atom <id> — used as sourceDocId for dedup. Falls
   *  back to the link, then to a title hash, when neither is present. */
  guid: string;
  title: string;
  link: string;
  /** Plain-text body (RSS <description> or Atom <summary> with HTML
   *  tags + entities stripped). 1-3 sentences typical. */
  summary: string;
  /** ISO-8601, derived from <pubDate> / <updated>. Empty when the
   *  feed item carries no date — caller should fill in fetch time. */
  publishedAt: string;
};

export function parseFeed(xml: string): RawFeedItem[] {
  if (typeof xml !== 'string' || xml.length === 0) return [];

  // RSS 2.0: <item>…</item>; Atom: <entry>…</entry>. Match both; the
  // sub-extractors handle tag-name differences.
  const itemBlocks: string[] = [];
  const itemRegex = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    itemBlocks.push(m[2] ?? '');
    if (itemBlocks.length >= 100) break; // cap per-feed work
  }

  return itemBlocks
    .map((block) => extractItem(block))
    .filter((it): it is RawFeedItem => it !== null);
}

function extractItem(block: string): RawFeedItem | null {
  const title = stripHtml(firstTag(block, 'title')) ?? '';
  if (!title) return null;
  // Atom <link href="..."/>; RSS <link>...</link>. Try both.
  const link =
    firstAttr(block, 'link', 'href') ??
    firstTag(block, 'link') ??
    '';
  const summary =
    stripHtml(firstTag(block, 'description')) ??
    stripHtml(firstTag(block, 'summary')) ??
    stripHtml(firstTag(block, 'content')) ??
    '';
  const pub =
    firstTag(block, 'pubDate') ??
    firstTag(block, 'published') ??
    firstTag(block, 'updated') ??
    '';
  const guidRaw = firstTag(block, 'guid') ?? firstTag(block, 'id') ?? link ?? title;
  return {
    guid: (guidRaw ?? '').trim(),
    title: title.trim(),
    link: (link ?? '').trim(),
    summary: summary.trim().slice(0, 800),
    publishedAt: normalizeDate(pub),
  };
}

function firstTag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  // Strip CDATA wrappers if present.
  const raw = m[1] ?? '';
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdata ? (cdata[1] ?? '') : raw;
}

function firstAttr(block: string, name: string, attr: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]+)"`, 'i');
  const m = block.match(re);
  return m ? (m[1] ?? null) : null;
}

function stripHtml(s: string | null): string | null {
  if (s == null) return null;
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
