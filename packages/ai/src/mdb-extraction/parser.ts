/**
 * MDB project-document PDF parser. Mirrors the GAIN parser shape with
 * MDB-specific candidate / discard section patterns.
 *
 * Splits an MDB project PDF (Project Appraisal Document / Loan
 * Proposal / Project Disclosure / etc.) into per-page text, then
 * groups lines into sections classified by header heuristics:
 *   - 'candidate'  — likely contains named contractors / borrowers /
 *                    suppliers; pass to LLM
 *   - 'discard'    — preamble / safeguards / references / annexes;
 *                    never extract
 *   - 'ambiguous'  — pattern unmatched; skip rather than guess
 *
 * Same deliberately-strict classifier as the GAIN parser: ambiguous
 * lines that LOOK like headers but don't match a known pattern are
 * not promoted to sections. The Day 3 extractor's prompt is robust
 * to receiving large unsplit text blocks if heuristics under-fire.
 */

import { extractText, getDocumentProxy } from 'unpdf';

export type MdbSectionKind = 'candidate' | 'discard' | 'ambiguous';

export interface MdbPdfSection {
  title: string;
  kind: MdbSectionKind;
  startPage: number;
  endPage: number;
  text: string;
}

export interface ParsedMdbDocument {
  pageCount: number;
  pageTexts: string[];
  sections: MdbPdfSection[];
}

/**
 * Section headers explicitly carrying named-counterparty signal in
 * MDB project documents. Anchored to line start.
 */
const CANDIDATE_HEADER_PATTERNS: RegExp[] = [
  // Procurement / awards
  /^(component\s+\d+\.?\s*[—:.\-]?\s*)?procurement(\s+plan|\s+arrangements?|\s+notice|\s+package)?/i,
  /^(component\s+\d+\.?\s*[—:.\-]?\s*)?contract\s+(award|arrangements?|signing)/i,
  /^(component\s+\d+\.?\s*[—:.\-]?\s*)?(awarded\s+contracts?|contract\s+packages?)/i,
  /^(component\s+\d+\.?\s*[—:.\-]?\s*)?(works|goods|consultant)\s+packages?/i,
  /^(component\s+\d+\.?\s*[—:.\-]?\s*)?bid(ders?|ding)/i,

  // Roles
  /^(borrower|borrowers?\s+and\s+implementing\s+arrangements?)/i,
  /^(implementing|executing)\s+(agency|agencies|entity|entities|arrangements?)/i,
  /^(contractors?|suppliers?|consultants?|sub-?contractors?)\s*$/i,
  /^(key|main|primary|principal)\s+(contractors?|suppliers?|consultants?|counterparties)/i,
  /^(project\s+)?beneficiar(y|ies)\s*$/i,
  /^(project\s+)?counterparties\s*$/i,
  /^(co-?financiers?|co-?lenders?|technical\s+advisors?)/i,

  // Component / package narratives
  /^component\s+\d+[\s:.\-—]/i,
  /^(part|sub-component)\s+[a-z\d]+[\s:.\-—]/i,
  /^package\s+[A-Z0-9-]+[\s:.\-—]/i,

  // IFC-specific (private sector)
  /^(client|investee)\s+(company|description|profile)/i,
  /^(project|company)\s+(description|sponsor|background)/i,
  /^summary\s+of\s+(investment|proposed\s+investment)/i,

  // Common MDB section labels with companies named
  /^description\s+of\s+the\s+project/i,
  /^project\s+description/i,
  /^(estimated\s+)?financing\s+(plan|sources)/i,
];

const DISCARD_HEADER_PATTERNS: RegExp[] = [
  // Safeguards / environmental
  /^(environmental|social)\s+(and\s+social\s+)?(safeguards?|management|impact|review|assessment)/i,
  /^(environmental|social)\s+review\s+summary/i,
  /^esrs\b|^esmp\b|^esmf\b|^rap\b|^rpf\b/i,
  /^operational\s+polic(y|ies)/i,
  /^safeguards?\s+(policies|triggered)/i,
  /^category\s+[abc]\s*(project)?/i,
  /^performance\s+standards?/i,

  // Annexes / references
  /^annex(\s+[a-z\d]+)?[\s:.\-]/i,
  /^appendix(\s+[a-z\d]+)?[\s:.\-]/i,
  /^references?\s*(:|$)/i,
  /^bibliography\s*(:|$)/i,
  /^(end\s+note|endnote|footnote)s?\s*(:|$)/i,
  /^abbreviations?\s+and\s+acronyms/i,
  /^acronyms?\s+and\s+abbreviations/i,
  /^glossary\s*(:|$)/i,

  // Disclosure / boilerplate
  /^(disclosure|disclosure\s+statement|disclaimer|copyright)/i,
  /^(distribution|distribution\s+approval)\s*$/i,
  /^(approved|cleared)\s+by\s*[:\-]/i,
  /^contact(\s+information|\s+details)?\s*$/i,

  // Rationale / preamble
  /^(project\s+)?(rationale|background|context|justification)\s*$/i,
  /^lessons\s+learned/i,
  /^results\s+framework/i,
  /^monitoring\s+and\s+evaluation/i,
  /^(strategic\s+)?alignment/i,

  // Risks
  /^risks?\s+and\s+mitigation/i,
  /^risk\s+(assessment|matrix|analysis)/i,

  // Financial mechanics (non-counterparty)
  /^terms\s+and\s+conditions/i,
  /^repayment\s+(schedule|terms)/i,
  /^disbursement\s+(schedule|arrangements)/i,
];

function isShortHeaderLike(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return false;
  if (/^\s*[A-Z][A-Z\s,&\-/]{2,100}\s*$/.test(trimmed)) return true;
  if (/^\s*\d{1,3}\.\d?\d?\s+[A-Z]/.test(trimmed)) return true;
  if (/^\s*[IVX]{1,5}\.\s+[A-Z]/.test(trimmed)) return true;
  if (/^\s*[a-z]\)\s+[A-Z]/i.test(trimmed)) return true;
  return false;
}

function classifyHeader(line: string): MdbSectionKind | null {
  const trimmed = line.trim();
  if (DISCARD_HEADER_PATTERNS.some((p) => p.test(trimmed))) return 'discard';
  if (CANDIDATE_HEADER_PATTERNS.some((p) => p.test(trimmed))) return 'candidate';
  return null;
}

function detectSections(pageTexts: string[]): MdbPdfSection[] {
  const tuples: Array<{ page: number; line: string }> = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const lines = (pageTexts[i] ?? '').split(/\r?\n/);
    for (const line of lines) tuples.push({ page: i + 1, line });
  }

  type Header = {
    index: number;
    page: number;
    text: string;
    kind: MdbSectionKind;
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

  const sections: MdbPdfSection[] = [];
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

export async function parseMdbPdf(
  pdfBuffer: Buffer | Uint8Array,
): Promise<ParsedMdbDocument> {
  const bytes =
    pdfBuffer instanceof Buffer ? new Uint8Array(pdfBuffer) : pdfBuffer;
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const pageTexts: string[] = Array.isArray(text) ? text : [text];
  return {
    pageCount: pdf.numPages,
    pageTexts,
    sections: detectSections(pageTexts),
  };
}
