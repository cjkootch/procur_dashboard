/**
 * Parse the free-text `notes` field on a known_entity into a
 * structured shape the entity profile page can render in distinct
 * panels. The wall-of-text format (description + contact + offer +
 * crude assay + fraction yields + source, all in one paragraph) was
 * unscannable on the page — see the National Oil Corporation Libya
 * profile for the worst case.
 *
 * Strategy: detect well-known section markers (CURRENT OFFER:,
 * WHOLE CRUDE GENERAL TESTS:, FRACTION YIELDS (TBP):, HYDROCARBON
 * TYPE..., Source:) and split the text into typed sections. Bullet
 * lines that follow `- Label: value (parenthetical)` parse to KV
 * rows for tabular rendering. Everything before the first section
 * marker is the description.
 *
 * Parser is forgiving: entities with simple one-liner notes pass
 * through with `description` populated and the rest empty.
 */

export interface AssayRow {
  /** Label / key (e.g. "API gravity", "Sulphur content"). */
  label: string;
  /** Value with units / parenthetical method (e.g. "0.120 wt% (ASTM D-4294)"). */
  value: string;
}

export interface AssaySection {
  /** Display title (e.g. "Whole Crude General Tests"). */
  title: string;
  rows: AssayRow[];
}

export interface ParsedEntityNotes {
  /** Free-text intro — everything before the first section marker.
   *  Contact lines (Tel:/Fax:/Email:) are removed and surfaced via
   *  `contact` so they render in their own panel. */
  description: string | null;
  /** Phone / fax / email / address pulled out of the description. */
  contact: {
    tels: string[];
    faxes: string[];
    emails: string[];
    address: string | null;
  } | null;
  /** Active offer text (everything after "CURRENT OFFER (...):" up
   *  to the next section marker). */
  offer: string | null;
  /** Highlight specs lifted from the assay for an at-a-glance strip
   *  on the profile page (API, sulfur, density, pour point, flash). */
  quickSpecs: AssayRow[];
  /** Each assay section in the original order. */
  assaySections: AssaySection[];
  /** Source citation (everything after "Source:"). */
  source: string | null;
}

const EMPTY: ParsedEntityNotes = {
  description: null,
  contact: null,
  offer: null,
  quickSpecs: [],
  assaySections: [],
  source: null,
};

/** Headers that introduce a typed section. Order matters — we walk
 *  newest-first when bisecting the input. */
const SECTION_MARKERS: Array<{
  kind: 'offer' | 'assay' | 'fractionYields' | 'hydrocarbon' | 'source';
  // First capture group should be the body that follows the marker.
  pattern: RegExp;
  title?: string;
}> = [
  {
    kind: 'offer',
    // CURRENT OFFER (user-confirmed): ... | CURRENT OFFER: ...
    pattern: /CURRENT OFFER(?:\s*\([^)]*\))?\s*:\s*/i,
  },
  {
    kind: 'assay',
    // WHOLE CRUDE GENERAL TESTS: ...
    pattern: /WHOLE CRUDE GENERAL TESTS\s*:\s*/i,
    title: 'Whole Crude General Tests',
  },
  {
    kind: 'fractionYields',
    // FRACTION YIELDS (TBP): ...
    pattern: /FRACTION YIELDS\s*(?:\([^)]*\))?\s*:\s*/i,
    title: 'Fraction Yields (TBP)',
  },
  {
    kind: 'hydrocarbon',
    // HYDROCARBON TYPE (70–175°C fraction, ASTM D5134 PIONA): ...
    pattern: /HYDROCARBON TYPE(?:\s*\([^)]*\))?\s*:\s*/i,
    title: 'Hydrocarbon Type',
  },
  {
    kind: 'source',
    // Source: ...
    pattern: /(?:^|[\s.])Source\s*:\s*/i,
  },
];

const QUICK_SPEC_LABELS = new Set([
  'api gravity',
  'sulphur content',
  'sulfur content',
  'density',
  'pour point',
  'flash point',
  'reid vapour pressure',
  'h2s',
]);

const TEL_RE = /(?:Tel|Phone)\s*:?\s*([+\d\s()/-]+?)(?=\s*(?:Fax|Email|\.\s|$))/gi;
const FAX_RE = /Fax\s*:?\s*([+\d\s()/-]+?)(?=\s*(?:Email|Tel|Phone|\.\s|$))/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const ADDRESS_RE = /(?:P\.?\s*O\.?\s*Box\s+\d+[^,.]*,\s*[^.]+|\d+[^,.]*\s+(?:Road|Street|Avenue|Blvd|Boulevard|km\s*\d+)[^.]+)/i;

/**
 * Main entry — parse a notes string into typed sections.
 * Returns EMPTY when notes is null/blank.
 */
export function parseEntityNotes(notes: string | null | undefined): ParsedEntityNotes {
  if (!notes || !notes.trim()) return EMPTY;

  // Find each marker's first occurrence + the kind it introduces.
  type Hit = {
    kind: typeof SECTION_MARKERS[number]['kind'];
    title?: string;
    start: number;
    bodyStart: number;
  };
  const hits: Hit[] = [];
  for (const m of SECTION_MARKERS) {
    m.pattern.lastIndex = 0;
    const match = m.pattern.exec(notes);
    if (match) {
      hits.push({
        kind: m.kind,
        title: m.title,
        start: match.index,
        bodyStart: match.index + match[0].length,
      });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  // Description = everything before the first hit.
  const firstHitStart = hits[0]?.start ?? notes.length;
  let description: string | null = notes.slice(0, firstHitStart).trim() || null;

  // Per-section bodies: from this hit's bodyStart to the next hit's start.
  const sectionBodies: Array<Hit & { body: string }> = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const next = hits[i + 1];
    const end = next?.start ?? notes.length;
    sectionBodies.push({ ...hit, body: notes.slice(hit.bodyStart, end).trim() });
  }

  let offer: string | null = null;
  let source: string | null = null;
  const assaySections: AssaySection[] = [];

  for (const sb of sectionBodies) {
    if (sb.kind === 'offer') {
      offer = stripTrailingFragments(sb.body);
    } else if (sb.kind === 'source') {
      source = stripTrailingFragments(sb.body);
    } else if (
      sb.kind === 'assay' ||
      sb.kind === 'fractionYields' ||
      sb.kind === 'hydrocarbon'
    ) {
      const rows = parseAssayBody(sb.body);
      if (rows.length > 0 && sb.title) {
        assaySections.push({ title: sb.title, rows });
      }
    }
  }

  // Pull contact lines out of the description and stash them in
  // `contact`. The description loses the noisy phone/fax soup but
  // keeps the editorial sentences.
  const contact = description ? extractContact(description) : null;
  if (contact && description) {
    description = stripContactFromDescription(description);
  }

  // Highlight specs from the whole-crude assay: API, sulfur, density,
  // pour, flash, RVP, H2S — the values a trader scans first.
  const quickSpecs: AssayRow[] = [];
  const wholeCrude = assaySections.find((s) => s.title === 'Whole Crude General Tests');
  if (wholeCrude) {
    for (const row of wholeCrude.rows) {
      const labelLower = row.label.toLowerCase();
      for (const key of QUICK_SPEC_LABELS) {
        if (labelLower.includes(key)) {
          quickSpecs.push(row);
          break;
        }
      }
    }
  }

  return {
    description: description?.trim() || null,
    contact: contactHasContent(contact) ? contact : null,
    offer,
    quickSpecs,
    assaySections,
    source,
  };
}

/** Parse "- Label: value (method)" bullets OR semicolon-separated
 *  inline KV blocks. Handles both the WHOLE CRUDE assay format and
 *  the HYDROCARBON TYPE PIONA format (single line, semicolons). */
function parseAssayBody(body: string): AssayRow[] {
  const rows: AssayRow[] = [];

  // First, try bullet-line parsing: split on lines that start with "-".
  const bullets = body
    .split(/(?:^|\s)[-•]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const bullet of bullets) {
    // "Label: value rest"
    const m = bullet.match(/^([^:]+?):\s*(.+)$/);
    if (m) {
      const label = m[1]!.trim();
      const value = m[2]!.trim().replace(/[,;]+$/, '');
      // Skip if the "label" looks like prose (too long).
      if (label.length <= 60 && value.length > 0) {
        rows.push({ label, value });
        continue;
      }
    }
    // No clear KV — treat the whole bullet as a single free-text row.
    if (bullet.length > 0 && bullet.length < 200) {
      rows.push({ label: '', value: bullet.trim() });
    }
  }

  // If no bullets found, try semicolon-separated KV (PIONA shape):
  // "n-Paraffins: 31.98 wt%; Iso-Paraffins: 25.72 wt%; ..."
  if (rows.length === 0) {
    const semi = body.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
    for (const seg of semi) {
      const m = seg.match(/^([^:]+?):\s*(.+)$/);
      if (m) {
        const label = m[1]!.trim();
        const value = m[2]!.trim();
        if (label.length <= 60 && value.length > 0) {
          rows.push({ label, value });
        }
      }
    }
  }

  return rows;
}

function extractContact(text: string): ParsedEntityNotes['contact'] {
  const tels: string[] = [];
  const faxes: string[] = [];
  const emails: string[] = [];

  const telMatches = text.matchAll(TEL_RE);
  for (const m of telMatches) {
    const v = (m[1] ?? '').trim().replace(/[.,;]+$/, '');
    if (v.length >= 4) tels.push(v);
  }
  const faxMatches = text.matchAll(FAX_RE);
  for (const m of faxMatches) {
    const v = (m[1] ?? '').trim().replace(/[.,;]+$/, '');
    if (v.length >= 4) faxes.push(v);
  }
  const emailMatches = text.matchAll(EMAIL_RE);
  for (const m of emailMatches) {
    emails.push(m[0]);
  }

  const addrMatch = text.match(ADDRESS_RE);
  const address = addrMatch ? addrMatch[0].trim().replace(/[.,;]+$/, '') : null;

  return {
    tels: dedupe(tels),
    faxes: dedupe(faxes),
    emails: dedupe(emails),
    address,
  };
}

function stripContactFromDescription(text: string): string {
  return text
    .replace(TEL_RE, '')
    .replace(FAX_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

function contactHasContent(c: ParsedEntityNotes['contact']): boolean {
  if (!c) return false;
  return (
    c.tels.length > 0 ||
    c.faxes.length > 0 ||
    c.emails.length > 0 ||
    c.address !== null
  );
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function stripTrailingFragments(s: string): string {
  return s.replace(/\s{2,}/g, ' ').trim();
}
