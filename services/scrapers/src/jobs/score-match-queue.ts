/**
 * Daily match-queue scoring job — per-tenant.
 *
 * Capstone of the strategic-vision.md loop. Every morning, scans
 * procur's recent counterparty signals — distress events, velocity
 * drops, fresh awards — and writes ranked rows to match_queue for
 * each tenant's /match-queue page.
 *
 * Per-tenant interest profile (companies table):
 *   preferred_categories     → category filter on awards & rationale
 *   preferred_jurisdictions  → buyer-country filter on awards
 *
 * If a tenant hasn't configured either field, scoring falls back to
 * the broad VTC defaults below so the queue is never empty for a
 * fresh account.
 *
 * Three signal sources, each with a baseline score + recency bonus:
 *
 *   distress_event (entity_news_events, last 7d, relevance >= 0.5)
 *     baseline 8.0 if relevance >= 0.8, else 6.0
 *     +1.0 if observed_at within 24h
 *     +0.5 if observed_at within 7d
 *
 *   velocity_drop (supplier_capability_summary, last_90d / prev_90d - 1 <= -0.5)
 *     baseline 7.0
 *     +0.5 always (it's a 90d-rolling signal — recency baked in)
 *
 *   new_award (awards, last 24h, in tenant category × jurisdiction set)
 *     baseline 4.0
 *     +0.5 if value > $10M
 *
 * Score capped at 9.99 (matches column precision). Idempotent on
 * (company_id, source_table, source_id) — re-running today's job
 * after a partial failure is safe.
 *
 * NOTE: distress_event and velocity_drop are fan-outs to every
 * tenant (those signals aren't category-scoped — a refiner going
 * bankrupt is interesting to anyone trading the lane). Only the
 * new_award path filters by the tenant's preferred categories +
 * jurisdictions, which is where multi-tenant differentiation shows
 * up most strongly.
 */
import { sql } from 'drizzle-orm';
import { db, companies } from '@procur/db';

const DEFAULT_CATEGORIES = [
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'marine-bunker',
];
const DEFAULT_JURISDICTIONS = [
  // Caribbean
  'DO', 'JM', 'TT', 'PR', 'BS', 'BB', 'HT',
  // Mediterranean
  'IT', 'ES', 'GR', 'TR', 'MT', 'CY',
  // LATAM
  'MX', 'CO', 'EC', 'PE', 'BR', 'PY', 'HN', 'GT', 'PA', 'AR', 'CR', 'NI', 'SV',
  // Africa (where VTC has flow exposure)
  'NG', 'AO', 'MA', 'DZ', 'GH', 'SN', 'EG', 'LY',
];

export type ScoreMatchQueueResult = {
  companies: number;
  distressInserted: number;
  velocityInserted: number;
  awardInserted: number;
  totalInserted: number;
};

export async function scoreMatchQueue(): Promise<ScoreMatchQueueResult> {
  const tenants = await db
    .select({
      id: companies.id,
      preferredCategories: companies.preferredCategories,
      preferredJurisdictions: companies.preferredJurisdictions,
    })
    .from(companies);

  let distressInserted = 0;
  let velocityInserted = 0;
  let awardInserted = 0;

  for (const tenant of tenants) {
    const categories =
      tenant.preferredCategories && tenant.preferredCategories.length > 0
        ? tenant.preferredCategories
        : DEFAULT_CATEGORIES;
    const jurisdictions =
      tenant.preferredJurisdictions && tenant.preferredJurisdictions.length > 0
        ? tenant.preferredJurisdictions
        : DEFAULT_JURISDICTIONS;

    distressInserted += await insertDistress(tenant.id);
    velocityInserted += await insertVelocity(tenant.id);
    awardInserted += await insertAwards(tenant.id, categories, jurisdictions);
  }

  return {
    companies: tenants.length,
    distressInserted,
    velocityInserted,
    awardInserted,
    totalInserted: distressInserted + velocityInserted + awardInserted,
  };
}

async function insertDistress(companyId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO match_queue (
      company_id,
      signal_type, signal_kind, source_table, source_id,
      known_entity_id, external_supplier_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
      ${companyId}::uuid,
      'distress_event',
      n.event_type,
      'entity_news_events',
      n.id::text,
      n.known_entity_id,
      n.external_supplier_id,
      n.source_entity_name,
      n.source_entity_country,
      NULL::text[],
      n.event_date,
      LEAST(
        9.99,
        CASE
          WHEN n.relevance_score IS NULL THEN 5.0
          WHEN n.relevance_score >= 0.8  THEN 8.0
          ELSE 6.0
        END
        + CASE
            WHEN n.event_date >= CURRENT_DATE - INTERVAL '1 day'  THEN 1.0
            WHEN n.event_date >= CURRENT_DATE - INTERVAL '7 days' THEN 0.5
            ELSE 0
          END
      )::numeric(4, 2),
      CONCAT(
        n.event_type, ' · ',
        n.source_entity_name,
        CASE WHEN n.source_entity_country IS NOT NULL
             THEN CONCAT(' (', n.source_entity_country, ')')
             ELSE ''
        END,
        ' · ', n.event_date::text
      )
    FROM entity_news_events n
    WHERE n.event_date >= CURRENT_DATE - INTERVAL '7 days'
      AND (n.relevance_score IS NULL OR n.relevance_score >= 0.5)
    ON CONFLICT (company_id, source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  return (result.rows as unknown[]).length;
}

async function insertVelocity(companyId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO match_queue (
      company_id,
      signal_type, signal_kind, source_table, source_id,
      external_supplier_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
      ${companyId}::uuid,
      'velocity_drop',
      'velocity_drop',
      'supplier_capability_summary',
      s.supplier_id::text,
      s.supplier_id,
      s.organisation_name,
      s.country,
      NULL::text[],
      COALESCE(s.most_recent_award_date, CURRENT_DATE),
      LEAST(9.99, 7.0 + 0.5)::numeric(4, 2),
      CONCAT(
        'awards down ',
        ROUND(
          ABS((s.awards_last_90d::float / NULLIF(s.awards_prev_90d, 0)::float - 1) * 100)::numeric,
          0
        )::text,
        '% (', s.awards_last_90d::text, ' vs ', s.awards_prev_90d::text, ' prior 90d)'
      )
    FROM supplier_capability_summary s
    WHERE s.awards_prev_90d >= 3
      AND ((s.awards_last_90d::float / NULLIF(s.awards_prev_90d, 0)::float) - 1) <= -0.5
    ON CONFLICT (company_id, source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  return (result.rows as unknown[]).length;
}

async function insertAwards(
  companyId: string,
  categories: string[],
  jurisdictions: string[],
): Promise<number> {
  const categoryArr = sql`ARRAY[${sql.join(
    categories.map((c) => sql`${c}`),
    sql`, `,
  )}]::text[]`;
  const jurisdictionArr = sql`ARRAY[${sql.join(
    jurisdictions.map((c) => sql`${c}`),
    sql`, `,
  )}]::text[]`;

  const result = await db.execute(sql`
    INSERT INTO match_queue (
      company_id,
      signal_type, signal_kind, source_table, source_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
      ${companyId}::uuid,
      'new_award',
      COALESCE(
        (SELECT t FROM unnest(a.category_tags) AS t
         WHERE t = ANY(${categoryArr})
         LIMIT 1),
        'unspecified'
      ),
      'awards',
      a.id::text,
      a.buyer_name,
      a.buyer_country,
      a.category_tags,
      a.award_date,
      LEAST(
        9.99,
        4.0
        + CASE
            WHEN a.contract_value_usd IS NOT NULL AND a.contract_value_usd >= 10000000
              THEN 0.5
            ELSE 0
          END
      )::numeric(4, 2),
      CONCAT(
        'new ',
        COALESCE(
          (SELECT t FROM unnest(a.category_tags) AS t
           WHERE t = ANY(${categoryArr})
           LIMIT 1),
          'fuel'
        ),
        ' award · ',
        a.buyer_name,
        ' (', a.buyer_country, ')',
        CASE WHEN a.contract_value_usd IS NOT NULL
             THEN CONCAT(' · $', ROUND(a.contract_value_usd / 1000000.0, 1)::text, 'M')
             ELSE ''
        END
      )
    FROM awards a
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '1 day'
      AND a.category_tags && ${categoryArr}
      AND a.buyer_country = ANY(${jurisdictionArr})
    ON CONFLICT (company_id, source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  return (result.rows as unknown[]).length;
}
