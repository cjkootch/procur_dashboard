/**
 * Extract quantities from awards.commodity_description and write
 * them to awards.quantity_bbl as a normalized barrel-equivalent.
 *
 * Why this exists: every Caribbean / LatAm fuel award publishes the
 * VOLUME inside the commodity description ("100,000 gallons of ULSD",
 * "1,500 metric tons of diesel"), but the schema only captures
 * contract_value_usd. To compute per-bbl deltas vs benchmark, we
 * need a per-award quantity. This script regex-extracts it.
 *
 * Patterns we recognize (case-insensitive):
 *   "100,000 bbl" / "100k barrels" / "1.5M bbls"
 *   "50,000 metric tons" / "50,000 MT" / "50000 tonnes" / "50,000 t"
 *   "1.5 million liters" / "1,500,000 L" / "1.5M liters"
 *   "1,000,000 gallons" / "1M gal"
 *   "5,000 m3" / "5,000 cubic meters"
 *
 * Unit conversions (to bbl):
 *   1 bbl = 1 bbl
 *   1 m3  = 6.2898 bbl
 *   1 L   = 0.006290 bbl
 *   1 gal = 0.02381 bbl  (US liquid gallon)
 *   1 MT  = category-specific:
 *     diesel       : 7.45 bbl/MT  (sg ~0.84)
 *     gasoline     : 8.40 bbl/MT  (sg ~0.74)
 *     jet-fuel     : 7.95 bbl/MT  (sg ~0.79)
 *     crude-oil    : 7.33 bbl/MT  (sg ~0.86)
 *     heavy-fuel   : 6.55 bbl/MT  (sg ~0.96)
 *     lpg-propane  : 11.6 bbl/MT  (sg ~0.51)
 *     unknown      : 7.45 bbl/MT  (diesel default)
 *
 * Confidence:
 *   1.0  explicit "X bbl/barrels"
 *   0.85 explicit gallons / liters / m3 (clean unit conversion)
 *   0.7  explicit MT with category-known specific gravity
 *   0.5  ambiguous units / fuzzy match
 *   NULL no extraction → quantity_bbl stays NULL
 *
 * Idempotent. Re-run after improving regexes; existing rows get
 * re-evaluated and overwritten.
 *
 * Run: pnpm --filter @procur/db backfill-award-quantities
 *      pnpm --filter @procur/db backfill-award-quantities --since=2023-01-01
 *      pnpm --filter @procur/db backfill-award-quantities --dry-run
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

/** bbl per 1 metric ton, indexed by category tag. */
const MT_TO_BBL: Record<string, number> = {
  diesel: 7.45,
  gasoline: 8.40,
  'jet-fuel': 7.95,
  'crude-oil': 7.33,
  'heavy-fuel-oil': 6.55,
  'fuel-oil': 6.55,
  'marine-bunker': 6.55,
  lpg: 11.6,
  'lpg-propane': 11.6,
  propane: 11.6,
};

const MT_TO_BBL_DEFAULT = 7.45; // diesel-typical fallback

/** Resolve the most-specific category from category_tags array. */
function inferCategory(tags: string[] | null): string | null {
  if (!tags) return null;
  const lower = tags.map((t) => t.toLowerCase());
  for (const cat of [
    'crude-oil',
    'jet-fuel',
    'gasoline',
    'diesel',
    'heavy-fuel-oil',
    'fuel-oil',
    'marine-bunker',
    'lpg-propane',
    'lpg',
    'propane',
  ]) {
    if (lower.includes(cat)) return cat;
  }
  return null;
}

type Extraction = {
  quantityBbl: number;
  method: string;
  confidence: number;
};

function parseMagnitude(raw: string): number | null {
  // Strip commas + spaces, lowercase suffix.
  const cleaned = raw.replace(/[,\s]/g, '').toLowerCase();
  // Match: number with optional decimal, optional k/m/b suffix or
  // following "million"/"thousand" word.
  const m = cleaned.match(/^([0-9]+(?:\.[0-9]+)?)([kmb]?)$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]) {
    case 'k':
      return n * 1_000;
    case 'm':
      return n * 1_000_000;
    case 'b':
      return n * 1_000_000_000;
    default:
      return n;
  }
}

/**
 * Try every pattern in order; first hit wins. Patterns are ordered by
 * specificity — explicit "bbl" > MT > liters > gallons > m³.
 */
function extract(description: string, category: string | null): Extraction | null {
  const text = description.toLowerCase();

  // Allow forms like "1.5 million", "1.5 m", "1,500", "100k", "100 k".
  // We capture <value> and <unit> separately; value normalizer below
  // does the multiplier work.
  const patterns: Array<{
    rx: RegExp;
    method: string;
    confidence: number;
    bblPer: (n: number) => number;
  }> = [
    // Explicit barrels
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*(?:bbl|barrels?|bbls)\b/i,
      method: 'explicit-bbl',
      confidence: 1.0,
      bblPer: (n) => n,
    },
    // Metric tons
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*(?:metric\s*tons?|mt|tonnes?|m\.t\.?|t\b)/i,
      method: 'mt-converted',
      confidence: 0.7,
      bblPer: (n) => {
        const factor: number =
          (category ? MT_TO_BBL[category] : undefined) ?? MT_TO_BBL_DEFAULT;
        return n * factor;
      },
    },
    // US gallons
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*(?:us\s*)?gallons?\b/i,
      method: 'gallons-converted',
      confidence: 0.85,
      bblPer: (n) => n * 0.02381,
    },
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*gal\b/i,
      method: 'gallons-converted',
      confidence: 0.85,
      bblPer: (n) => n * 0.02381,
    },
    // Liters
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*(?:liters?|litres?)\b/i,
      method: 'liters-converted',
      confidence: 0.85,
      bblPer: (n) => n * 0.006290,
    },
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*l\b/i,
      method: 'liters-converted',
      confidence: 0.6, // 'L' alone is more ambiguous (could be Litres / size code)
      bblPer: (n) => n * 0.006290,
    },
    // Cubic meters
    {
      rx: /([\d,]+(?:\.\d+)?\s*(?:million|thousand)?(?:\s*[kmb])?)\s*(?:m3|m³|cubic\s*met(?:re|er)s?)\b/i,
      method: 'm3-converted',
      confidence: 0.85,
      bblPer: (n) => n * 6.2898,
    },
  ];

  for (const p of patterns) {
    const m = text.match(p.rx);
    if (!m) continue;
    let valuePart = m[1]!.trim();
    // Map "5 million" / "5 thousand" → magnitude suffix our parser eats.
    valuePart = valuePart
      .replace(/\bmillion\b/i, 'm')
      .replace(/\bthousand\b/i, 'k')
      .replace(/\s+/g, '');
    const num = parseMagnitude(valuePart);
    if (num == null) continue;
    const bbl = p.bblPer(num);
    if (!Number.isFinite(bbl) || bbl <= 0) continue;
    return {
      quantityBbl: Math.round(bbl * 1000) / 1000,
      method: p.method,
      confidence: p.confidence,
    };
  }

  return null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const dryRun = process.argv.includes('--dry-run');
  const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
  const since = sinceArg ?? '2020-01-01';

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  // Pull rows with descriptions worth processing. Skip rows where
  // quantity_bbl is already populated unless --reprocess is set.
  const reprocess = process.argv.includes('--reprocess');
  const where = reprocess
    ? sql`commodity_description IS NOT NULL AND award_date >= ${since}::date`
    : sql`commodity_description IS NOT NULL AND quantity_bbl IS NULL AND award_date >= ${since}::date`;

  const rowsResult = await db.execute(sql`
    SELECT id, commodity_description, category_tags
    FROM awards
    WHERE ${where}
    ORDER BY award_date DESC;
  `);
  const rows = rowsResult.rows as Array<{
    id: string;
    commodity_description: string | null;
    category_tags: string[] | null;
  }>;

  console.log(
    `Scanning ${rows.length} awards (since=${since}, reprocess=${reprocess})...`,
  );

  const counts: Record<string, number> = {};
  const successes: Array<{
    id: string;
    quantityBbl: number;
    method: string;
    confidence: number;
  }> = [];
  let unmatched = 0;

  for (const r of rows) {
    if (!r.commodity_description) {
      unmatched += 1;
      continue;
    }
    const cat = inferCategory(r.category_tags);
    const ext = extract(r.commodity_description, cat);
    if (!ext) {
      unmatched += 1;
      continue;
    }
    successes.push({ id: r.id, ...ext });
    counts[ext.method] = (counts[ext.method] ?? 0) + 1;
  }

  console.log(
    `Extracted ${successes.length} / ${rows.length} (${(
      (successes.length / Math.max(rows.length, 1)) *
      100
    ).toFixed(1)}%); unmatched=${unmatched}`,
  );
  for (const [method, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method}: ${n}`);
  }

  if (dryRun) {
    console.log('\nDry run — no writes. Sample of 10 extractions:');
    for (const s of successes.slice(0, 10)) {
      console.log(
        `  ${s.id} → ${s.quantityBbl.toFixed(2)} bbl  (${s.method}, conf ${s.confidence})`,
      );
    }
    return;
  }

  // Batch update — Neon HTTP doesn't love huge IN-lists, so chunk
  // 200 at a time using a CASE expression.
  let written = 0;
  const chunkSize = 200;
  for (let i = 0; i < successes.length; i += chunkSize) {
    const chunk = successes.slice(i, i + chunkSize);
    // Using individual UPDATEs for simplicity; one round-trip per row
    // is fine at our row counts (~6k awards) and avoids assembling a
    // large CASE statement.
    for (const s of chunk) {
      await db.execute(sql`
        UPDATE awards SET
          quantity_bbl = ${s.quantityBbl},
          quantity_extraction_method = ${s.method},
          quantity_extraction_confidence = ${s.confidence},
          updated_at = NOW()
        WHERE id = ${s.id};
      `);
      written += 1;
    }
    if ((i + chunkSize) % 1000 === 0 || i + chunkSize >= successes.length) {
      console.log(`  ...wrote ${Math.min(written, successes.length)}/${successes.length}`);
    }
  }

  console.log(`Done. ${written} rows updated.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
