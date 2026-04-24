function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// UTF-8 BOM — helps Excel open the file with correct character encoding.
const BOM = '﻿';

/**
 * Minimal RFC 4180 CSV encoder. Values are coerced to strings and quoted if
 * they contain commas, quotes, or newlines. Prepends a BOM so Excel opens it
 * with UTF-8 encoding.
 */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map(escape).join(','));
  }
  return `${BOM}${lines.join('\n')}\n`;
}

export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
