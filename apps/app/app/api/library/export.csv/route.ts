import { requireCompany } from '@procur/auth';
import {
  LIBRARY_TYPES,
  LIBRARY_TYPE_LABEL,
  listLibrary,
  type LibraryType,
} from '../../../../lib/library-queries';
import { csvResponse, toCsv } from '../../../../lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isLibraryType(v: string | null): v is LibraryType {
  return Boolean(v) && (LIBRARY_TYPES as readonly string[]).includes(v as string);
}

/**
 * Content library CSV export. Honors the same `?q=` and `?type=`
 * filters as /library so the download matches what's on screen.
 *
 * Body content is included in full so users can copy/paste passages
 * back into proposals offline. The embedding column is binary noise,
 * so we expose a boolean "Indexed" flag instead.
 */
export async function GET(req: Request): Promise<Response> {
  const { company } = await requireCompany();
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const typeParam = url.searchParams.get('type');
  const type: LibraryType | null = isLibraryType(typeParam) ? typeParam : null;

  const all = await listLibrary(company.id);
  const rows = all.filter((e) => {
    if (type && e.type !== type) return false;
    if (q.length > 0) {
      const haystack = [e.title, e.content, ...(e.tags ?? [])]
        .filter(Boolean)
        .join('  ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const headers = ['Library ID', 'Type', 'Title', 'Tags', 'Content', 'Indexed', 'Updated at'];

  const csvRows = rows.map((e) => [
    e.id,
    LIBRARY_TYPE_LABEL[e.type as LibraryType] ?? e.type,
    e.title,
    (e.tags ?? []).join(' | '),
    e.content,
    e.embedding ? 'yes' : 'no',
    e.updatedAt.toISOString(),
  ]);

  const csv = toCsv(headers, csvRows);
  const today = new Date().toISOString().slice(0, 10);
  return csvResponse(`procur-library-${today}.csv`, csv);
}
