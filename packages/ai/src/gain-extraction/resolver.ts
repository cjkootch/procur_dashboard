/**
 * GAIN importer-mention resolver — Stage 5 of
 * gain-extraction-brief.md.
 *
 * For each gain_importer_mentions row whose resolved_entity_id is
 * null and whose extraction confidence is ≥ MIN_CONFIDENCE:
 *
 *   1. Exact normalized match against known_entities.name + aliases.
 *      Stamps method='exact_normalized', confidence=0.95.
 *
 *   2. Trigram fuzzy match (pg_trgm similarity ≥ FUZZY_HIGH=0.85).
 *      Stamps method='fuzzy_high', confidence=similarity * 0.9.
 *
 *   3. Auto-create a shadow `known_entities` row for the mention.
 *      Slug = `gain-{iso2}-{slugifiedName}`, country from the report,
 *      categories from commodityCategories (mapped to canonical
 *      KNOWN_ENTITY_CATEGORIES), tags include 'gain-curated'.
 *      Stamps method='auto_created', confidence=extractionConfidence.
 *
 * Idempotent: skips mentions where resolved_entity_id is already set.
 * Cross-report dedup: if "Alimentos Polar" appears in three reports,
 * the first mention auto-creates the slug; subsequent mentions resolve
 * to the same slug via the exact-match phase.
 *
 * Provenance: every auto-created entity carries metadata.source =
 * 'gain_extraction' + the originating report id, so `tags
 * @> ['gain-curated']` is enough to mass-delete if calibration is off.
 */

import { sql, and, isNull, gte, eq } from 'drizzle-orm';
import { type drizzle as drizzleType } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';

type Db = ReturnType<typeof drizzleType<typeof schema>>;

const MIN_CONFIDENCE = 0.7;
const FUZZY_HIGH = 0.85;

/**
 * Map GAIN commodity categories (snake_case, HS-aligned) to the
 * canonical KNOWN_ENTITY_CATEGORIES (kebab-case). Unknown values
 * fall through to 'food-commodities'. Every result always includes
 * 'food-commodities' as the umbrella so list-by-category queries
 * find every promoted entity.
 */
const COMMODITY_TO_CATEGORY: Record<string, string> = {
  wheat: 'wheat',
  corn: 'corn',
  soybean: 'soybean',
  soybean_oil: 'soybean',
  soybean_meal: 'soybean',
  rice: 'rice',
  sugar: 'sugar',
  beef: 'beef',
  pork: 'pork',
  poultry: 'poultry',
  dairy: 'dairy',
  oilseeds_other: 'oilseeds',
  palm_oil: 'palm-oil',
  // No canonical category — these all collapse onto food-commodities:
  sorghum: 'food-commodities',
  barley: 'food-commodities',
  cotton: 'food-commodities',
  coffee: 'food-commodities',
  cocoa: 'food-commodities',
  tobacco: 'food-commodities',
  cassava: 'food-commodities',
  feed: 'food-commodities',
  pulses: 'food-commodities',
  tree_nuts: 'food-commodities',
  fish_seafood: 'food-commodities',
  food_processed: 'food-commodities',
  fertilizer: 'fertilizer',
  other: 'food-commodities',
};

function mapCategories(commodityCategories: string[]): string[] {
  const out = new Set<string>(['food-commodities']);
  for (const c of commodityCategories) {
    const mapped = COMMODITY_TO_CATEGORY[c];
    if (mapped) out.add(mapped);
  }
  return Array.from(out);
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accent strip
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface PendingMention {
  id: string;
  companyName: string;
  companyNameNormalized: string;
  roles: string[];
  commodityCategories: string[];
  contextExcerpt: string;
  marketPosition: string | null;
  extractionConfidence: string;
  reportId: string;
  reportCountryCode: string;
  reportTitle: string;
  reportNumber: string | null;
}

export interface ResolveGainMentionsArgs {
  /** Max mentions to resolve this run. Default 200. */
  limit?: number;
  /** Min extractionConfidence to consider. Default 0.7. */
  minConfidence?: number;
}

export interface ResolveGainMentionsResult {
  processed: number;
  matchedExact: number;
  matchedFuzzy: number;
  autoCreated: number;
  errors: number;
  remaining: number;
}

export async function resolveGainMentions(
  db: Db,
  args: ResolveGainMentionsArgs = {},
): Promise<ResolveGainMentionsResult> {
  const limit = args.limit ?? 200;
  const minConfidence = args.minConfidence ?? MIN_CONFIDENCE;

  const rows = (await db
    .select({
      id: schema.gainImporterMentions.id,
      companyName: schema.gainImporterMentions.companyName,
      companyNameNormalized: schema.gainImporterMentions.companyNameNormalized,
      roles: schema.gainImporterMentions.roles,
      commodityCategories: schema.gainImporterMentions.commodityCategories,
      contextExcerpt: schema.gainImporterMentions.contextExcerpt,
      marketPosition: schema.gainImporterMentions.marketPosition,
      extractionConfidence: schema.gainImporterMentions.extractionConfidence,
      reportId: schema.gainImporterMentions.reportId,
      reportCountryCode: schema.gainReports.countryCode,
      reportTitle: schema.gainReports.title,
      reportNumber: schema.gainReports.reportId,
    })
    .from(schema.gainImporterMentions)
    .innerJoin(
      schema.gainReports,
      eq(schema.gainImporterMentions.reportId, schema.gainReports.id),
    )
    .where(
      and(
        isNull(schema.gainImporterMentions.resolvedEntityId),
        gte(
          schema.gainImporterMentions.extractionConfidence,
          String(minConfidence),
        ),
      ),
    )
    .orderBy(schema.gainImporterMentions.extractedAt)
    .limit(limit)) as PendingMention[];

  let matchedExact = 0;
  let matchedFuzzy = 0;
  let autoCreated = 0;
  let errors = 0;

  for (const m of rows) {
    try {
      // ── Phase 1: exact-normalized match against known_entities ────
      const exactHit = await db
        .select({ slug: schema.knownEntities.slug })
        .from(schema.knownEntities)
        .where(
          sql`lower(${schema.knownEntities.name}) = ${m.companyNameNormalized}
              OR EXISTS (
                SELECT 1 FROM unnest(${schema.knownEntities.aliases}) AS a
                WHERE lower(a) = ${m.companyNameNormalized}
              )`,
        )
        .limit(1);

      if (exactHit[0]?.slug) {
        await stampResolution(db, m.id, exactHit[0].slug, 'exact_normalized', 0.95);
        matchedExact += 1;
        continue;
      }

      // ── Phase 2: trigram fuzzy match ─────────────────────────────
      // Restrict to same-country candidates so "Forum (VE)" doesn't
      // resolve to "Forum (PA)". Limits cross-country bleed-through.
      const fuzzy = (await db.execute(sql`
        SELECT slug, similarity(lower(name), ${m.companyNameNormalized}) AS sim
        FROM known_entities
        WHERE country = ${m.reportCountryCode}
          AND similarity(lower(name), ${m.companyNameNormalized}) > ${FUZZY_HIGH}
        ORDER BY sim DESC
        LIMIT 1
      `)) as unknown as { rows: Array<{ slug: string; sim: number }> };
      const fuzzyHit = fuzzy.rows?.[0];
      if (fuzzyHit && fuzzyHit.sim > FUZZY_HIGH) {
        await stampResolution(
          db,
          m.id,
          fuzzyHit.slug,
          'fuzzy_high',
          Math.min(0.99, Number(fuzzyHit.sim) * 0.9),
        );
        matchedFuzzy += 1;
        continue;
      }

      // ── Phase 3: auto-create stub in known_entities ──────────────
      const baseSlug = `gain-${m.reportCountryCode.toLowerCase()}-${slugifyName(m.companyName)}`;
      const slug = baseSlug.slice(0, 100);
      const categories = mapCategories(m.commodityCategories);
      const primaryRole = m.roles[0] ?? 'importer';
      const tags = Array.from(
        new Set([
          'gain-curated',
          'auto-promoted',
          `gain-${primaryRole}`,
          ...m.commodityCategories.map((c) => `gain-${c}`),
        ]),
      );
      const notes = composeNotes(m);
      const metadata: Record<string, unknown> = {
        source: 'gain_extraction',
        gain_report_id: m.reportId,
        gain_report_number: m.reportNumber,
        gain_market_position: m.marketPosition,
      };

      await db
        .insert(schema.knownEntities)
        .values({
          slug,
          name: m.companyName,
          country: m.reportCountryCode,
          role: primaryRole,
          categories,
          notes,
          aliases: [],
          tags,
          metadata,
        })
        .onConflictDoNothing({ target: schema.knownEntities.slug });

      await stampResolution(
        db,
        m.id,
        slug,
        'auto_created',
        Number(m.extractionConfidence),
      );
      autoCreated += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'gain-resolver',
          msg: 'mention failed — continuing',
          mentionId: m.id,
          companyName: m.companyName,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Remaining tally.
  const remainingResult = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.gainImporterMentions)
    .where(
      and(
        isNull(schema.gainImporterMentions.resolvedEntityId),
        gte(
          schema.gainImporterMentions.extractionConfidence,
          String(minConfidence),
        ),
      ),
    );
  const remaining = remainingResult[0]?.n ?? 0;

  return {
    processed: rows.length,
    matchedExact,
    matchedFuzzy,
    autoCreated,
    errors,
    remaining,
  };
}

async function stampResolution(
  db: Db,
  mentionId: string,
  slug: string,
  method: string,
  confidence: number,
): Promise<void> {
  await db
    .update(schema.gainImporterMentions)
    .set({
      resolvedEntityId: slug,
      resolutionMethod: method,
      resolutionConfidence: String(confidence.toFixed(2)),
    })
    .where(eq(schema.gainImporterMentions.id, mentionId));
}

function composeNotes(m: PendingMention): string {
  const lines: string[] = [];
  lines.push(`Mentioned in USDA FAS GAIN report "${m.reportTitle}"${m.reportNumber ? ` (${m.reportNumber})` : ''}.`);
  if (m.roles.length > 0) {
    lines.push(`Roles: ${m.roles.join(', ')}.`);
  }
  if (m.commodityCategories.length > 0) {
    lines.push(`Commodity categories: ${m.commodityCategories.join(', ')}.`);
  }
  if (m.marketPosition && m.marketPosition !== 'unknown') {
    lines.push(`Market position: ${m.marketPosition}.`);
  }
  if (m.contextExcerpt) {
    const excerpt = m.contextExcerpt.length > 400
      ? `${m.contextExcerpt.slice(0, 400)}…`
      : m.contextExcerpt;
    lines.push(`Excerpt: ${excerpt}`);
  }
  lines.push('Auto-promoted from GAIN extraction; review and refine via the operator UI.');
  return lines.join(' ');
}
