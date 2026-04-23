import * as cheerio from 'cheerio';

export type Dom = cheerio.CheerioAPI;
// cheerio.Cheerio is generic over AnyNode; callers rarely need the node type.
// Use `ReturnType<Dom>` to get the concrete Cheerio collection type from the loader.
export type Node = ReturnType<Dom>;

export function loadHtml(html: string): Dom {
  return cheerio.load(html);
}

export function textOf($el: Node): string {
  return $el.text().replace(/\s+/g, ' ').trim();
}

export function attrOf($el: Node, name: string): string | null {
  const value = $el.attr(name);
  return value ? value.trim() : null;
}

export function absoluteUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function extractTable($: Dom, selector: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  const $table = $(selector).first();
  if ($table.length === 0) return rows;

  const headers: string[] = [];
  $table.find('thead th, tr:first-child th').each((_i, el) => {
    headers.push(textOf($(el)));
  });

  $table.find('tbody tr').each((_i, tr) => {
    const row: Record<string, string> = {};
    $(tr)
      .find('td')
      .each((i, td) => {
        const key = headers[i] ?? `col_${i}`;
        row[key] = textOf($(td));
      });
    if (Object.keys(row).length > 0) rows.push(row);
  });

  return rows;
}
