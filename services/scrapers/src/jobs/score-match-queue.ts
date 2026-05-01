/**
 * Daily match-queue scoring job.
 *
 * Capstone of the strategic-vision.md loop. Scans procur's recent
 * counterparty signals — distress events, velocity drops, fresh
 * awards — and writes ranked rows to match_queue for the
 * /match-queue page.
 *
 * v1 ships with a hardcoded interest profile keyed to VTC's lane:
 *   categories: crude-oil, diesel, gasoline, jet-fuel, marine-bunker
 *   regions   : Caribbean (DO/JM/TT/PR/BS), Mediterranean (IT/ES/GR/TR),
 *               LATAM (MX/CO/EC/PE/BR/PY/HN/GT/PA/AR), Africa (NG/AO/MA/DZ),
 *               Mid-East distress origin signals (anywhere)
 * Per-user interest profiles come in a follow-up.
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
 *   new_award (awards, last 24h, in target category × country set)
 *     baseline 4.0
 *     +0.5 if value > $10M
 *
 * Score capped at 9.99 (matches column precision). Idempotent on
 * (source_table, source_id) — re-running today's job after a
 * partial failure is safe.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

const TARGET_CATEGORIES = [
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'marine-bunker',
];
const TARGET_COUNTRIES = [
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
  distressInserted: number;
  velocityInserted: number;
  awardInserted: number;
  totalInserted: number;
};

export async function scoreMatchQueue(): Promise<ScoreMatchQueueResult> {
  // ── 1. Distress events — entity_news_events last 7d, relevance ≥ 0.5
  // (NULL counts as "not yet scored"; we still surface those — better
  // false-positives early than missing high-signal events while the
  // scoring job catches up).
  const distressResult = await db.execute(sql`
    INSERT INTO match_queue (
      signal_type, signal_kind, source_table, source_id,
      known_entity_id, external_supplier_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
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
      -- Use the LLM-extracted 1-2 sentence summary as rationale.
      -- The legacy template ("event_type · entity (country) · date")
      -- duplicated info already rendered in the row's score, signal
      -- pill, entity, and date columns — every line read identically.
      n.summary
    FROM entity_news_events n
    WHERE n.event_date >= CURRENT_DATE - INTERVAL '7 days'
      AND (n.relevance_score IS NULL OR n.relevance_score >= 0.5)
    ON CONFLICT (source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  const distressInserted = (distressResult.rows as unknown[]).length;

  // ── 2. Velocity drops — suppliers whose 90d-window awards dropped
  // ≥ 50% vs the prior 90d. Same threshold as findDistressedSuppliers.
  const velocityResult = await db.execute(sql`
    INSERT INTO match_queue (
      signal_type, signal_kind, source_table, source_id,
      external_supplier_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
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
    ON CONFLICT (source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  const velocityInserted = (velocityResult.rows as unknown[]).length;

  // ── 3. Fresh awards — last 24h, in target category × country set.
  // Buyer-side signal: someone just bought meaningful diesel in our
  // territory; we want eyes on the supplier who won it (in case it
  // becomes recurring) AND on the buyer (in case of repeat spend).
  const awardResult = await db.execute(sql`
    INSERT INTO match_queue (
      signal_type, signal_kind, source_table, source_id,
      source_entity_name, source_entity_country,
      category_tags, observed_at, score, rationale
    )
    SELECT
      'new_award',
      COALESCE(
        (SELECT t FROM unnest(a.category_tags) AS t
         WHERE t = ANY(${sql.join(
           TARGET_CATEGORIES.map((c) => sql`${c}`),
           sql`, `,
         )}::text[])
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
      -- Buyer name + country are already rendered in the row's
      -- entity column. Rationale carries category + value only.
      CONCAT(
        COALESCE(
          (SELECT t FROM unnest(a.category_tags) AS t
           WHERE t = ANY(${sql.join(
             TARGET_CATEGORIES.map((c) => sql`${c}`),
             sql`, `,
           )}::text[])
           LIMIT 1),
          'fuel'
        ),
        ' award',
        CASE WHEN a.contract_value_usd IS NOT NULL
             THEN CONCAT(' · $', ROUND(a.contract_value_usd / 1000000.0, 1)::text, 'M')
             ELSE ''
        END
      )
    FROM awards a
    WHERE a.award_date >= CURRENT_DATE - INTERVAL '1 day'
      AND a.category_tags && ${sql.join(
        TARGET_CATEGORIES.map((c) => sql`${c}`),
        sql`, `,
      )}::text[]
      AND a.buyer_country = ANY(${sql.join(
        TARGET_COUNTRIES.map((c) => sql`${c}`),
        sql`, `,
      )}::text[])
    ON CONFLICT (source_table, source_id) DO NOTHING
    RETURNING id;
  `);
  const awardInserted = (awardResult.rows as unknown[]).length;

  return {
    distressInserted,
    velocityInserted,
    awardInserted,
    totalInserted: distressInserted + velocityInserted + awardInserted,
  };
}
