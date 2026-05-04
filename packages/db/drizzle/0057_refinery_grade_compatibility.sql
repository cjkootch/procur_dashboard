-- Materialized refinery × crude-grade compatibility view.
--
-- Joins `known_entities` (metadata.slate envelopes) against
-- `crude_grades` (api_gravity / sulfur_pct / tan property scalars)
-- to produce a per-pair fit boolean. Replaces manual cross-
-- referencing for "which refineries can run Es Sider?" / "which
-- grades fit Saras?" lookups.
--
-- Compatibility semantics (each predicate is permissive on missing
-- data — NULL slate field or NULL grade property is treated as
-- "no constraint", not "fail"):
--   - api_compatible:    grade.api_gravity within [slate.apiMin, slate.apiMax]
--   - sulfur_compatible: grade.sulfur_pct <= slate.sulfurMaxPct
--   - tan_compatible:    grade.tan        <= slate.tanMax
--   - slate_compatible:  ALL of the above pass
--
-- Implemented as a regular view, not materialized. The Cartesian
-- product is bounded (~25 grades × <100 slated refineries = <2500
-- rows) and Postgres can compute it in <50ms per query, so the
-- ops cost of a MATERIALIZED VIEW + REFRESH triggers is not worth
-- the freshness loss.
--
-- JSONB key vocabulary is camelCase (`apiMin` not `min_api`) — the
-- shared TS interface in `@procur/catalog/slate-capability.ts` is
-- the source of truth for the key names. The seed-refinery-slate
-- migration to camelCase ships alongside this migration.

CREATE OR REPLACE VIEW refinery_grade_compatibility AS
SELECT
  ke.slug                          AS refinery_slug,
  ke.name                          AS refinery_name,
  ke.country                       AS refinery_country,
  ke.role                          AS refinery_role,
  cg.slug                          AS grade_slug,
  cg.name                          AS grade_name,
  cg.origin_country                AS grade_origin_country,
  cg.region                        AS grade_region,
  cg.api_gravity                   AS grade_api_gravity,
  cg.sulfur_pct                    AS grade_sulfur_pct,
  cg.tan                           AS grade_tan,

  -- Slate envelope echo for the renderer.
  (ke.metadata->'slate'->>'apiMin')::numeric         AS slate_api_min,
  (ke.metadata->'slate'->>'apiMax')::numeric         AS slate_api_max,
  (ke.metadata->'slate'->>'sulfurMaxPct')::numeric   AS slate_sulfur_max_pct,
  (ke.metadata->'slate'->>'tanMax')::numeric         AS slate_tan_max,
  (ke.metadata->'slate'->>'complexityIndex')::numeric AS slate_complexity_index,
  (ke.metadata->'slate'->>'crudeUnitCapacityBpd')::numeric AS slate_capacity_bpd,

  -- Per-dimension compatibility (NULL = "unknown / unconstrained" = pass).
  CASE
    WHEN cg.api_gravity IS NULL
      OR (ke.metadata->'slate'->>'apiMin') IS NULL
      OR (ke.metadata->'slate'->>'apiMax') IS NULL THEN TRUE
    ELSE cg.api_gravity BETWEEN
      (ke.metadata->'slate'->>'apiMin')::numeric
      AND (ke.metadata->'slate'->>'apiMax')::numeric
  END AS api_compatible,

  CASE
    WHEN cg.sulfur_pct IS NULL
      OR (ke.metadata->'slate'->>'sulfurMaxPct') IS NULL THEN TRUE
    ELSE cg.sulfur_pct <= (ke.metadata->'slate'->>'sulfurMaxPct')::numeric
  END AS sulfur_compatible,

  CASE
    WHEN cg.tan IS NULL
      OR (ke.metadata->'slate'->>'tanMax') IS NULL THEN TRUE
    ELSE cg.tan <= (ke.metadata->'slate'->>'tanMax')::numeric
  END AS tan_compatible,

  -- Aggregate fit — all dimensions pass.
  (
    (CASE
      WHEN cg.api_gravity IS NULL
        OR (ke.metadata->'slate'->>'apiMin') IS NULL
        OR (ke.metadata->'slate'->>'apiMax') IS NULL THEN TRUE
      ELSE cg.api_gravity BETWEEN
        (ke.metadata->'slate'->>'apiMin')::numeric
        AND (ke.metadata->'slate'->>'apiMax')::numeric
    END)
    AND (CASE
      WHEN cg.sulfur_pct IS NULL
        OR (ke.metadata->'slate'->>'sulfurMaxPct') IS NULL THEN TRUE
      ELSE cg.sulfur_pct <= (ke.metadata->'slate'->>'sulfurMaxPct')::numeric
    END)
    AND (CASE
      WHEN cg.tan IS NULL
        OR (ke.metadata->'slate'->>'tanMax') IS NULL THEN TRUE
      ELSE cg.tan <= (ke.metadata->'slate'->>'tanMax')::numeric
    END)
  ) AS slate_compatible
FROM known_entities ke
CROSS JOIN crude_grades cg
WHERE ke.role = 'refiner'
  AND ke.metadata IS NOT NULL
  AND ke.metadata->'slate' IS NOT NULL;
