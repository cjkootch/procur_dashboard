/**
 * USDA FAS GAIN report parser — Day 2 of gain-extraction-brief.md.
 *
 * Splits a GAIN PDF into per-page text, then groups lines into
 * sections classified by header heuristics:
 *   - 'candidate'  — likely contains named importers; pass to LLM
 *   - 'discard'    — reference / regulatory / contact; never extract
 *   - 'ambiguous'  — pattern unmatched; skip rather than guess
 *
 * The classifier is deliberately strict: ambiguous lines that LOOK
 * like headers but don't match a known section pattern are not
 * promoted to sections at all. Better to miss a section than spawn
 * a low-quality LLM call. The Day 3 extractor's prompt is robust to
 * receiving large blocks of unsplit text if heuristics fail.
 *
 * Per brief §3.3, GAIN reports follow a standardized layout
 * (Executive Summary → Market Overview → Distribution → commodity
 * sections → Trade Data → Post Contact). The patterns below target
 * that taxonomy.
 */

import { extractText, getDocumentProxy } from 'unpdf';

export type GainSectionKind = 'candidate' | 'discard' | 'ambiguous';

export interface GainSection {
  /** The header line that opened the section. */
  title: string;
  kind: GainSectionKind;
  /** 1-indexed page of the header. */
  startPage: number;
  /** 1-indexed page where the next header (or end-of-document) was found. */
  endPage: number;
  /** Concatenated section text (header line + body until next header). */
  text: string;
}

export interface ParsedGainReport {
  pageCount: number;
  /** Per-page raw text. The LLM extractor reads sections, but downstream
   *  page-mapping (for source_page on importer mentions) uses this. */
  pageTexts: string[];
  sections: GainSection[];
}

/**
 * Section headers explicitly carrying named-importer signal. Matches are
 * anchored to line start so accidental mid-paragraph matches don't
 * trigger.
 */
const CANDIDATE_HEADER_PATTERNS: RegExp[] = [
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?market\s+(overview|summary|landscape|structure)/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?distribution(\s+channels?|\s+sector|\s+landscape)?\s*$/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?channels?\s+of\s+distribution/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?(major|key|leading|top|main|principal)\s+(importers?|distributors?|retailers?|players?|companies|wholesalers?|millers?|processors?|operators?)/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?(importers?|wholesalers?|distributors?|retailers?)\s*$/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?retail(\s+sector|\s+foods?|\s+market|\s+landscape|\s+segment)?/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?supermarket/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?food\s+service/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?(hotel,?\s*restaurant,?\s*(institutional|and\s+institutional)|hri\b)/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?consumer\s+(food|sector|spending)/i,
  /^(section\s+[ivxlcd]+\.?\s*[—:.\-]?\s*)?(wheat|soybeans?|soybean\s+(oil|meal)|corn|maize|sugar|beef|poultry|pork|dairy|rice|sorghum|barley|oilseeds?|cotton|coffee|cocoa|tobacco|cassava|palm\s+oil|fish|seafood|dry\s+beans?|pulses?|fertili[sz]er|feed)(\s+(imports?|sector|market|industry|trade|production|consumption))?\b/i,
];

/**
 * Section headers that name regulators / references / contact info — no
 * commercial counterparties. Filtered out aggressively to keep LLM cost
 * and false-positive rate low.
 */
const DISCARD_HEADER_PATTERNS: RegExp[] = [
  /^(post\s+)?contact(\s+information|\s+details)?\s*$/i,
  /^(useful|key|important|usda)\s+contacts/i,
  /^(sources?|references?|bibliography)\s*(:|$|cited|consulted)/i,
  /^annex(\s+[a-z\d]+)?[\s:.\-]/i,
  /^appendix(\s+[a-z\d]+)?[\s:.\-]/i,
  /^(end\s+note|endnote|footnote)s?\s*(:|$)/i,
  /^(fairs|food\s+and\s+agricultural\s+import\s+regulations)/i,
  /^(sanitary|phytosanitary|sps)\b/i,
  /^(import\s+regulations|food\s+regulations|food\s+laws|labeling\s+regulations)/i,
  /^(disclaimer|copyright|trademark|attribution)/i,
  /^trade\s+data\s+tables?\s*$/i,
];

/**
 * A line LOOKS like a header if it's short, isolated, and matches a
 * formatting pattern (ALL CAPS, numbered, title-case). We then check
 * classifyHeader() to decide what kind of section it opens.
 */
function isShortHeaderLike(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 110) return false;
  if (/^\s*[A-Z][A-Z\s,&\-/]{2,80}\s*$/.test(trimmed)) return true;
  if (/^\s*\d{1,3}\.\d?\s+[A-Z]/.test(trimmed)) return true;
  if (/^\s*[IVX]{1,5}\.\s+[A-Z]/.test(trimmed)) return true;
  return false;
}

function classifyHeader(line: string): GainSectionKind | null {
  const trimmed = line.trim();
  if (DISCARD_HEADER_PATTERNS.some((p) => p.test(trimmed))) return 'discard';
  if (CANDIDATE_HEADER_PATTERNS.some((p) => p.test(trimmed))) return 'candidate';
  return null;
}

function detectSections(pageTexts: string[]): GainSection[] {
  const tuples: Array<{ page: number; line: string }> = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const lines = (pageTexts[i] ?? '').split(/\r?\n/);
    for (const line of lines) tuples.push({ page: i + 1, line });
  }

  type Header = {
    index: number;
    page: number;
    text: string;
    kind: GainSectionKind;
  };
  const headers: Header[] = [];
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i];
    if (!t) continue;
    if (!isShortHeaderLike(t.line)) continue;
    const kind = classifyHeader(t.line);
    if (kind == null) continue;
    headers.push({ index: i, page: t.page, text: t.line.trim(), kind });
  }

  const sections: GainSection[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i];
    if (!start) continue;
    const nextHeader = headers[i + 1];
    const endIdx = nextHeader ? nextHeader.index : tuples.length;
    const slice = tuples.slice(start.index, endIdx);
    const text = slice
      .map((t) => t.line)
      .join('\n')
      .trim();
    const lastTuple = slice[slice.length - 1] ?? slice[0];
    sections.push({
      title: start.text,
      kind: start.kind,
      startPage: start.page,
      endPage: lastTuple?.page ?? start.page,
      text,
    });
  }
  return sections;
}

/**
 * Fallback when heuristic header detection finds no candidate sections.
 * Current GAIN reports use title-case section headers ("Production
 * Outlook", "Trade Outlook") that the all-caps / numbered heuristics
 * miss. Rather than skip the report outright, treat the whole document
 * as one candidate section so the LLM extractor still runs. Per the
 * parser docstring: "The Day 3 extractor's prompt is robust to
 * receiving large blocks of unsplit text if heuristics fail."
 */
function fallbackWholeDocumentSection(
  pageTexts: ReadonlyArray<string>,
): GainSection {
  const joined = pageTexts.join('\n\n').trim();
  return {
    title: 'Full document (fallback parse)',
    kind: 'candidate',
    startPage: 1,
    endPage: pageTexts.length,
    text: joined,
  };
}

export async function parseGainPdf(
  pdfBuffer: Buffer | Uint8Array,
): Promise<ParsedGainReport> {
  const bytes =
    pdfBuffer instanceof Buffer ? new Uint8Array(pdfBuffer) : pdfBuffer;
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pageTexts: string[] = Array.isArray(text) ? text : [text];
  const heuristicSections = detectSections(pageTexts);
  const hasCandidate = heuristicSections.some((s) => s.kind === 'candidate');
  const sections = hasCandidate
    ? heuristicSections
    : [fallbackWholeDocumentSection(pageTexts)];
  return {
    pageCount: pdf.numPages,
    pageTexts,
    sections,
  };
}
