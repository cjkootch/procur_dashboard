-- Recursive ownership walks — UP (entity → parents) and DOWN
-- (parent → subsidiaries). Implemented as PL/SQL functions backed
-- by recursive CTEs so the chat-tool layer can fetch the full
-- chain in one round trip instead of N+1 traversal.
--
-- Brief: docs/data-graph-connections-brief.md §3.2 (work item 2).
--
-- Each call:
--   1. Resolves p_entity_name to a starting subject_gem_id via
--      trigram fuzzy match (same approach as the existing
--      getOwnershipChain helper in @procur/catalog).
--   2. Walks the graph up to `p_max_depth` hops (default 10),
--      following EVERY edge — multiple parents at the same level
--      surface separately (Eni S.p.A. → 30% Italian govt + 70%
--      public). Deduped on a depth+visited basis to prevent
--      infinite recursion on data errors.
--
-- Return shape mirrors `entity_ownership` columns plus a `depth`
-- counter and a `path` array (the chain of GEM IDs from the seed
-- to the current node) so callers can render the full lineage
-- without re-querying.
--
-- Performance notes:
--   - The recursive CTE uses parent_gem_id / subject_gem_id which
--     are already btree-indexed (entity_ownership_subject_gem_idx
--     + entity_ownership_parent_gem_idx).
--   - max_depth=10 is generous; typical chains are 2-4 deep
--     (subject → operator → parent → ultimate beneficial owner).
--     Cap exists to defend against a cycle in the source data.
--   - Initial fuzzy seed match uses trigram similarity (% operator
--     with the gin_trgm_ops indexes) so "Eni" / "Eni S.p.A." /
--     "Eni SpA" all hit.
--
-- Naming: `lookup_ownership_chain_up` walks UPWARD (the brief's
-- name); `lookup_subsidiaries` walks downward. Both return the
-- seed entity at depth=0 so the caller can render
-- "Sannazzaro Refinery [seed] → operator Eni S.p.A. → 30% Italian
-- Government" as a single ordered list.

CREATE OR REPLACE FUNCTION lookup_ownership_chain_up(
  p_entity_name text,
  p_max_depth int DEFAULT 10,
  p_min_similarity numeric DEFAULT 0.55
)
RETURNS TABLE (
  depth int,
  subject_gem_id text,
  subject_name text,
  parent_gem_id text,
  parent_name text,
  share_pct numeric,
  share_imputed boolean,
  source_urls text,
  path text[]
)
LANGUAGE SQL
STABLE
AS $$
  WITH RECURSIVE seed AS (
    -- Resolve the input name to the best fuzzy-matched subject row.
    -- We only need ONE seed (the highest-similarity row); subsequent
    -- recursion follows the graph, not the name.
    SELECT eo.subject_gem_id
    FROM entity_ownership eo
    WHERE eo.subject_name % p_entity_name
      AND similarity(eo.subject_name, p_entity_name) >= p_min_similarity
    ORDER BY similarity(eo.subject_name, p_entity_name) DESC
    LIMIT 1
  ),
  chain AS (
    -- Anchor: every direct parent of the seed entity.
    SELECT
      1 AS depth,
      eo.subject_gem_id,
      eo.subject_name,
      eo.parent_gem_id,
      eo.parent_name,
      eo.share_pct,
      eo.share_imputed,
      eo.source_urls,
      ARRAY[eo.subject_gem_id, eo.parent_gem_id] AS path
    FROM entity_ownership eo
    JOIN seed ON eo.subject_gem_id = seed.subject_gem_id

    UNION ALL

    -- Recursion: for each frontier parent, find its parents.
    SELECT
      c.depth + 1 AS depth,
      eo.subject_gem_id,
      eo.subject_name,
      eo.parent_gem_id,
      eo.parent_name,
      eo.share_pct,
      eo.share_imputed,
      eo.source_urls,
      c.path || eo.parent_gem_id AS path
    FROM chain c
    JOIN entity_ownership eo
      ON eo.subject_gem_id = c.parent_gem_id
    WHERE c.depth < p_max_depth
      -- Cycle guard: don't revisit a GEM ID already on this path.
      AND NOT (eo.parent_gem_id = ANY(c.path))
  )
  SELECT
    chain.depth,
    chain.subject_gem_id,
    chain.subject_name,
    chain.parent_gem_id,
    chain.parent_name,
    chain.share_pct,
    chain.share_imputed,
    chain.source_urls,
    chain.path
  FROM chain
  ORDER BY chain.depth ASC, chain.share_pct DESC NULLS LAST;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION lookup_subsidiaries(
  p_entity_name text,
  p_max_depth int DEFAULT 10,
  p_min_share_pct numeric DEFAULT 0,
  p_min_similarity numeric DEFAULT 0.55
)
RETURNS TABLE (
  depth int,
  parent_gem_id text,
  parent_name text,
  subject_gem_id text,
  subject_name text,
  share_pct numeric,
  share_imputed boolean,
  source_urls text,
  path text[]
)
LANGUAGE SQL
STABLE
AS $$
  WITH RECURSIVE seed AS (
    -- Resolve the input name to a parent_gem_id. Subsidiary walks
    -- start from the parent side; we match against parent_name
    -- because the input is "find subsidiaries OF X".
    SELECT eo.parent_gem_id
    FROM entity_ownership eo
    WHERE eo.parent_name % p_entity_name
      AND similarity(eo.parent_name, p_entity_name) >= p_min_similarity
    ORDER BY similarity(eo.parent_name, p_entity_name) DESC
    LIMIT 1
  ),
  chain AS (
    SELECT
      1 AS depth,
      eo.parent_gem_id,
      eo.parent_name,
      eo.subject_gem_id,
      eo.subject_name,
      eo.share_pct,
      eo.share_imputed,
      eo.source_urls,
      ARRAY[eo.parent_gem_id, eo.subject_gem_id] AS path
    FROM entity_ownership eo
    JOIN seed ON eo.parent_gem_id = seed.parent_gem_id
    WHERE COALESCE(eo.share_pct, 0) >= p_min_share_pct

    UNION ALL

    SELECT
      c.depth + 1 AS depth,
      eo.parent_gem_id,
      eo.parent_name,
      eo.subject_gem_id,
      eo.subject_name,
      eo.share_pct,
      eo.share_imputed,
      eo.source_urls,
      c.path || eo.subject_gem_id AS path
    FROM chain c
    JOIN entity_ownership eo
      ON eo.parent_gem_id = c.subject_gem_id
    WHERE c.depth < p_max_depth
      AND COALESCE(eo.share_pct, 0) >= p_min_share_pct
      AND NOT (eo.subject_gem_id = ANY(c.path))
  )
  SELECT
    chain.depth,
    chain.parent_gem_id,
    chain.parent_name,
    chain.subject_gem_id,
    chain.subject_name,
    chain.share_pct,
    chain.share_imputed,
    chain.source_urls,
    chain.path
  FROM chain
  ORDER BY chain.depth ASC, chain.share_pct DESC NULLS LAST;
$$;
