# Data Graph Connections — Closing the Gaps Between Existing Tables

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-30
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/strategic-vision.md` (the destination state these connections enable), `docs/intelligence-layers-brief.md` (the data sources these connections leverage), `docs/specialty-crude-strategy.md` (the niche where the slate-fit and ownership connections specifically pay off)

This brief specifies five distinct work items that connect data already-present in procur's schema but currently siloed. None of these require new ingestion sources; all leverage data that's already loaded. Collectively they represent roughly 6-12 days of focused work and convert procur from "deep data warehouse" into "deep data warehouse with the connections that actually matter for VTC's commercial strategy."

If you're new to this project, read the strategic-vision and intelligence-layers briefs first. Then this. The build briefs that came before this one populated the tables; this one wires them together.

---

## 1. Why this brief exists

Procur's schema currently includes 55 tables. The data is genuinely deep:

- 5,982+ awards across 10 OCDS publishers
- 26K rows of corporate ownership relationships from GEM GEOT
- Curated rolodex of refineries / traders / producers with lat/lng and slate metadata
- Producer-published crude assays (ExxonMobil, BP, Equinor, TotalEnergies) with full TBP cut breakdowns
- Live AIS vessel positions across Mediterranean / Caribbean / US Gulf / West Africa
- Eurostat Comext customs flow data covering EU-reported imports
- Pricing benchmarks and FX rates
- LLM-tagged news events from RSS feeds
- Per-tenant supplier KYC tracking
- A proactive match queue capstone

**The data is ahead of the connections between it.** Five specific intersections where existing data sits in tables that don't currently talk to each other are what determine whether procur reads as "Bloomberg terminal shaped" versus "very-good-startup shaped" for VTC's specific niche. This brief closes those gaps.

The order of priority reflects strategic leverage relative to the commercial-strategy and specialty-crude-strategy documents — the highest-leverage connections come first. Each section is independently shippable; you can do them in priority order or in parallel.

---

## 2. Work item 1: Crude assay properties × refinery slate metadata

**Strategic value:** Very high. The specialty crude track in `docs/specialty-crude-strategy.md` is built on grade-matching as the analytical capability that justifies the niche. This connection is what makes that capability actually work.

**Estimated effort:** 2-3 days

**Strategic priority:** 1 of 5

### 2.1 The problem

You have `crude_assays` with detailed material properties: API gravity, sulfur, TAN, viscosity, vanadium, nickel, mercaptan, H2S, RVP, pour point. You have producer-published assay data for major grades from ExxonMobil, BP, Equinor, TotalEnergies. You have `crude_assay_cuts` with full TBP yield breakdowns.

You have `known_entities.metadata.slate` describing what each refinery can run.

These two data sources never join. Today, answering "which refineries can run Es Sider crude" requires manual cross-referencing — query the assay, read the slate metadata, eyeball the comparison. Repeat for every grade × refinery combination that matters.

This is the analytical engine for the specialty crude conversation. Without it, claims about grade-fit are pattern-matched. With it, they are deterministic and defensible.

### 2.2 The solution

Three deliverables:

**(a) Standardized slate-capability schema.** The free-form `metadata.slate` field becomes a structured object with specific keys:

```typescript
interface RefinerySlateCapability {
  /** Crude API gravity envelope. Below apiMin or above apiMax,
   *  the refinery cannot run the grade efficiently. */
  apiMin: number;
  apiMax: number;

  /** Maximum sulfur content the desulfurization train can handle.
   *  In wt% — e.g. 0.5 for sweet-only refineries, 3.5 for full sour. */
  sulfurMaxPct: number;

  /** Maximum total acid number. >0.5 starts requiring corrosion-
   *  resistant metallurgy; >1.0 is high-TAN specialty configuration. */
  tanMax: number;

  /** Maximum heavy-metals content the catalysts can tolerate. */
  vanadiumMaxPpm: number;
  nickelMaxPpm: number;

  /** Whether the refinery has acidic-tolerant metallurgy throughout. */
  acidicTolerance: boolean;

  /** Crude unit nameplate capacity, barrels per day. */
  crudeUnitCapacityBpd: number;

  /** Nelson Complexity Index. >12 is high-conversion (FCC + coker
   *  + hydrocracker + alkylation); 6-9 is mid-complexity; <6 is
   *  hydroskimming. Drives the product-economics calculation
   *  in §6 (work item 5). */
  complexityIndex: number;

  /** Free-text notes on capability nuances that don't fit the
   *  numeric envelope (e.g. "can blend up to 30% heavy sour"). */
  notes: string;
}
```

For the top 60-80 refineries in the rolodex (Tier 1 Caribbean / LatAm / West African plus the specialty crude buyer universe from the bilateral counterparties research), populate this structured envelope from public refinery descriptions, IEA refinery configuration data, GEM GEOT operational data, and analyst research. About 30-40 minutes per refinery; ~1.5-2 days of total research time.

The rest of the rolodex's `metadata.slate` stays free-form for now and gets structured opportunistically as those refineries become commercially relevant.

**(b) Deterministic slate-fit calculator.** A SQL view + assistant tool:

```sql
CREATE OR REPLACE VIEW refinery_grade_compatibility AS
SELECT
  ke.slug AS refinery_slug,
  ke.name AS refinery_name,
  ke.country AS refinery_country,
  cg.slug AS grade_slug,
  cg.name AS grade_name,
  cg.origin_country AS grade_origin,
  -- Compatibility flags (TRUE = grade fits the slate envelope)
  (cg.api_gravity BETWEEN
     (ke.metadata->'slate'->>'apiMin')::numeric AND
     (ke.metadata->'slate'->>'apiMax')::numeric) AS api_compatible,
  (cg.sulfur_pct <= (ke.metadata->'slate'->>'sulfurMaxPct')::numeric) AS sulfur_compatible,
  (cg.tan IS NULL OR cg.tan <= (ke.metadata->'slate'->>'tanMax')::numeric) AS tan_compatible,
  -- Aggregate fit (all dimensions must pass)
  (cg.api_gravity BETWEEN
     (ke.metadata->'slate'->>'apiMin')::numeric AND
     (ke.metadata->'slate'->>'apiMax')::numeric)
   AND (cg.sulfur_pct <= (ke.metadata->'slate'->>'sulfurMaxPct')::numeric)
   AND (cg.tan IS NULL OR cg.tan <= (ke.metadata->'slate'->>'tanMax')::numeric)
   AS slate_compatible
FROM known_entities ke
CROSS JOIN crude_grades cg
WHERE ke.role = 'refiner'
  AND ke.metadata->'slate' IS NOT NULL
  AND ke.metadata->'slate'->>'apiMin' IS NOT NULL;
```

The view is a Cartesian product of refiners × grades, which sounds heavy but is bounded — typically 200 refiners × 100 grades = 20K rows, refreshable on schema change. Index on `(refinery_slug, slate_compatible)` and `(grade_slug, slate_compatible)` for fast lookup.

**(c) Two assistant tools** in `packages/catalog/src/tools/`:

```typescript
/**
 * Given a crude grade, return the refineries whose slate envelope
 * accepts it. Sorted by Nelson complexity desc (more sophisticated
 * refineries first — they extract more value from the grade).
 *
 * Use when the operator is sourcing a specialty cargo and needs to
 * find buyers, or when discussing specialty crude flows.
 */
find_refineries_for_grade(args: {
  gradeSlug: string;
  /** Optional: restrict to refineries within freight feasibility. */
  withinNmOfPort?: { portSlug: string; maxNm: number };
  /** Optional: restrict to specific countries. */
  inCountries?: string[];
}) => RefineryMatch[]

/**
 * Given a refinery, return the grades whose properties fit its
 * slate envelope. Sorted by current pricing differential — grades
 * trading at a discount appear first (likely best margin for the
 * refiner if they have flexibility).
 *
 * Use when discussing a refiner's procurement options, or when
 * preparing outreach to a refinery's crude procurement team.
 */
find_grades_for_refinery(args: {
  refinerySlug: string;
  /** Optional: filter to grades originating from specific regions. */
  fromRegions?: string[];
  /** Optional: limit to grades that are currently available (have
      had a recent assay, are not from sanctioned-blocked origins
      for the refiner's compliance perimeter). */
  currentlyAvailable?: boolean;
}) => GradeMatch[]
```

Both tools return shaped results with the slate-fit dimensions explained — the operator can see *why* a particular grade fits or doesn't, not just yes/no.

### 2.3 What this enables

Outreach messages like *"Looking at your facility's slate configuration — API tolerance 28-38, sulfur cap 1.2%, TAN cap 0.4 — we have visibility into Es Sider (37° API, 0.4% sulfur, low TAN) cargoes outside the typical term-contract structure. Cycle time from inquiry to delivered cargo is typically 30-45 days under our standard structures."*

Specifically: the assistant can compose messages like the above for any combination of refinery × grade in the database, in seconds. The empirical slate-fit reasoning is what makes the message land as "this trader actually understands my refinery" rather than "this trader sent a generic email."

For the specialty crude track, this is the analytical foundation. **Without it, every conversation about grade-matching is a soft claim. With it, every conversation about grade-matching is sourced from structured data.**

### 2.4 Edge cases and limitations

- **Crude_grades doesn't have all the properties for the slate calculation.** Some grades have `api_gravity` and `sulfur_pct` but lack `tan` or `vanadium` data. The view treats `NULL` as "we don't know — assume compatible if slate has a tan limit." This is permissive by design; better to surface a possible match the operator can investigate than to filter it out.
- **Slate metadata isn't always public for every refinery.** The 60-80 Tier 1 entities are well-documented. The long tail isn't. Refineries without structured slate metadata simply don't appear in the compatibility view; they get added opportunistically.
- **Slate envelopes are simplifications.** Real refineries blend multiple grades and operate within a slate *range* whose boundaries depend on the rest of the slate composition. The structured envelope captures the outer bounds; production planning is more nuanced. This is acceptable for the deal-origination use case (we're identifying *candidate* matches, not committing the refinery to a slate); explicitly flagged in tool documentation.

---

## 3. Work item 2: Entity ownership graph wiring

**Strategic value:** High. Changes how counterparties are understood at a fundamental level. Critical for sanctions cascades, consolidation detection, and sovereign-exposure assessment.

**Estimated effort:** 1-2 days

**Strategic priority:** 2 of 5

### 3.1 The problem

You have `entity_ownership` populated from GEM GEOT — 26K rows of corporate ownership relationships across the energy industry. The data is structurally good: subject entity, parent entity, share percentage, source URLs, fuzzy-name indexes for lookup.

**Nothing in the codebase queries it.** No assistant tool surfaces ownership chains. No entity profile shows sovereign backing. No sanctions screening walks the ownership graph for transitive exposure. No competitive analysis groups awards by ultimate parent.

The data is loaded. The wiring isn't.

### 3.2 The solution

Three deliverables:

**(a) Two ownership-walking SQL functions:**

```sql
-- Walk up the chain: entity → parent → grandparent → ...
CREATE OR REPLACE FUNCTION lookup_ownership_chain_up(p_entity_name text)
RETURNS TABLE (
  depth int,
  subject_name text,
  parent_name text,
  share_pct numeric,
  share_imputed boolean
) AS $$
WITH RECURSIVE chain AS (
  -- Anchor: the input entity
  SELECT 0 AS depth,
         eo.subject_name,
         eo.parent_name,
         eo.share_pct,
         eo.share_imputed,
         eo.parent_gem_id
  FROM entity_ownership eo
  WHERE eo.subject_name ILIKE p_entity_name
     OR eo.subject_name % p_entity_name  -- trigram similarity
  UNION ALL
  -- Recursion: follow the parent_gem_id
  SELECT c.depth + 1,
         eo.subject_name,
         eo.parent_name,
         eo.share_pct,
         eo.share_imputed,
         eo.parent_gem_id
  FROM chain c
  JOIN entity_ownership eo ON eo.subject_gem_id = c.parent_gem_id
  WHERE c.depth < 10  -- safety: prevent infinite recursion on data errors
)
SELECT depth, subject_name, parent_name, share_pct, share_imputed
FROM chain
ORDER BY depth;
$$ LANGUAGE SQL STABLE;

-- Walk down the chain: entity → subsidiaries → sub-subsidiaries → ...
CREATE OR REPLACE FUNCTION lookup_subsidiaries(p_entity_name text)
RETURNS TABLE (
  depth int,
  parent_name text,
  subject_name text,
  share_pct numeric
) AS $$
-- Symmetric to above, walking down via subject_gem_id
WITH RECURSIVE chain AS (
  SELECT 0 AS depth,
         eo.parent_name,
         eo.subject_name,
         eo.share_pct,
         eo.subject_gem_id
  FROM entity_ownership eo
  WHERE eo.parent_name ILIKE p_entity_name
     OR eo.parent_name % p_entity_name
  UNION ALL
  SELECT c.depth + 1,
         eo.parent_name,
         eo.subject_name,
         eo.share_pct,
         eo.subject_gem_id
  FROM chain c
  JOIN entity_ownership eo ON eo.parent_gem_id = c.subject_gem_id
  WHERE c.depth < 10
)
SELECT depth, parent_name, subject_name, share_pct
FROM chain
ORDER BY depth, share_pct DESC;
$$ LANGUAGE SQL STABLE;
```

**(b) Two assistant tools** wrapping the SQL functions:

```typescript
/**
 * Walk the upstream ownership chain for an entity. Returns the
 * chain of parents, ultimately resolving to the highest-level owner
 * (typically a government, a public listing, or a private holding).
 *
 * Use when assessing sovereign exposure, evaluating sanctions risk,
 * or composing outreach that references corporate structure.
 */
lookup_ownership_chain(args: {
  entityName: string;
}) => OwnershipChainEntry[]

/**
 * Walk the downstream ownership chain — every subsidiary and
 * sub-subsidiary owned (>0%) by the named parent.
 *
 * Use when evaluating consolidation in a market (which awards
 * "different" entities are actually under the same ultimate
 * ownership), or when assessing the full footprint of a producer /
 * trading house.
 */
lookup_subsidiaries(args: {
  entityName: string;
  /** Minimum share percentage to include. Default 0 (include all
      reported relationships). For "controlling interest" analysis,
      pass 50. */
  minSharePct?: number;
}) => SubsidiaryEntry[]
```

**(c) UI integration:**

- **Entity profile pages:** an "Ownership" panel showing the upstream chain (3-5 levels typical) ending at the ultimate beneficial owner, plus subsidiaries with >50% control. For state-owned entities, prominently display the sovereign backing (e.g. "100% Government of Algeria"). For corporate hierarchies, show the consolidation pattern.

- **Awards consolidation view:** a `/suppliers/competitors` enhancement that groups awards by ultimate parent rather than by named awardee. The DR Caribbean fuel database already shows Coral + Next = Grupo Propagas; the ownership-aware view does this automatically across all jurisdictions.

- **Sanctions screening cascade:** when entity X is screened and any ownership-chain ancestor is on a sanctions list at >50% control, the screen result includes a "transitive sanctions exposure" finding. This implements the OFAC "50 Percent Rule" structurally rather than relying on vex's screening agent to handle it ad hoc.

### 3.3 What this enables

**Sovereign exposure on every refinery profile.** When you look at "Sannazzaro Refinery," the profile shows: *operator: Eni S.p.A. → 30.3% Italian Government, 69.7% public free float*. This is meaningful context. State-backed refineries make decisions differently from privately-held ones; sovereign exposure also affects sanctions sensitivity in ways that matter for Vector Antilles operations.

**Consolidation detection.** Your existing DR Caribbean fuel analysis manually identified Coral + Next as Grupo Propagas. With ownership-aware queries, *every* market analysis automatically groups affiliates. When you query "DR diesel suppliers in last 24 months," you see Grupo Propagas (combined $247M) at the top, not three separate entities at $80-100M each. Your competitive landscape gets meaningfully more accurate.

**Sanctions cascades.** When OFAC adds a Russian holding company to the SDN list, every subsidiary it owns >50% is also sanctioned. The transitive screening makes this visible at first glance rather than requiring counsel to trace it manually deal by deal. Critical for Vector Antilles work.

**Outreach specificity for state-owned entities.** Messages to a Sonatrach commercial director can reference the corporate structure: *"As Sonatrach is wholly owned by the Algerian state, I understand procurement decisions go through formal channels. Our Dubai-based affiliate operates with experience working with sovereign-backed marketing arms..."* This is the difference between generic outreach and outreach that demonstrates structural sophistication.

### 3.4 Edge cases and limitations

- **GEM GEOT's coverage is energy-industry focused.** It captures the major oil/gas players well. It captures food commodity traders less well (Bunge, Cargill, ADM, Louis Dreyfus do appear; smaller traders may not). For VTC's food commodity work — which is a smaller fraction of the deal mix — ownership wiring may be incomplete.
- **Entity name matching across procur and GEM GEOT is fuzzy.** The trigram indexes on `entity_ownership.subject_name` and `parent_name` enable approximate matching, but exact alias resolution is imperfect. For high-stakes decisions, the operator should verify the resolved chain rather than relying on automatic matching alone.
- **Share percentages are point-in-time.** GEM GEOT updates periodically; ownership changes in real time. For deals that hinge on current ownership (a recent IPO, a state divestiture, an acquisition), supplement with current corporate filings.

---

## 4. Work item 3: Match queue feedback loop

**Strategic value:** High. Compound benefit over time — every closed deal calibrates the scoring, and the scoring becomes more reliable each month. Strategic-vision document explicitly called out the need for this feedback loop.

**Estimated effort:** 1-2 days

**Strategic priority:** 3 of 5

### 4.1 The problem

The `match_queue` table has a status field with values `open | dismissed | pushed-to-vex | actioned`. Pushed matches flow into vex. **There's no flow back from vex telling procur whether the deal closed.**

Without that feedback, the proactive matching engine's scoring is static. Matches that were never going to close keep getting recommended at the same weight. Matches that consistently lead to closed deals don't get reinforced. The operator's intuition about which signals are real has no structural mechanism to inform the scoring algorithm.

The strategic-vision document's destination state (§9 — discipline rules around the matching engine) explicitly calls for closing this loop. Without it, the matching engine slowly degrades toward "another tool nobody trusts."

### 4.2 The solution

Three deliverables:

**(a) Schema additions to `match_queue`:**

```typescript
// Add to existing match_queue table
{
  // ... existing fields ...

  /** When the matched entity was engaged through vex.
   *  NULL until the operator pushes the match. */
  pushedToVexAt: timestamp('pushed_to_vex_at', { withTimezone: true }),

  /** Vex's deal ID once a deal materializes from this match.
   *  NULL until vex creates a fuel_deal linked to the entity. */
  vexDealId: text('vex_deal_id'),

  /** Outcome reported by vex when the linked deal terminates.
   *  NULL until terminal state.
   *  'closed_won': deal closed, VTC realized margin
   *  'closed_lost': deal pursued but didn't close
   *  'no_engagement': pushed but no real conversation occurred
   *  'still_active': pushed long ago, deal still open (open at 90+ days) */
  dealOutcome: text('deal_outcome'),

  /** When dealOutcome was set. */
  outcomeRecordedAt: timestamp('outcome_recorded_at', { withTimezone: true }),

  /** Realized margin in USD if dealOutcome = 'closed_won'.
   *  Null otherwise. Captured from vex's deal close metrics. */
  realizedMarginUsd: numeric('realized_margin_usd', { precision: 14, scale: 2 }),
}
```

**(b) Webhook endpoint for vex to report outcomes:**

```typescript
// POST /api/intelligence/match-outcome
// Body: { sourceTable, sourceId, vexDealId?, outcome, marginUsd? }
//
// Vex calls this when:
//   - A push from procur creates a fuel_deal (sets vexDealId)
//   - A fuel_deal transitions to terminal state (sets outcome)
//   - 90 days pass without the entity being engaged (auto-mark
//     no_engagement)
//
// Bearer-auth via PROCUR_API_TOKEN, same as existing endpoints.
```

This requires a small addition to vex's existing procur-integration code — when a `fuel_deal` is created from a procur lead and when one terminates, ping the new endpoint. About 50 lines of vex-side code; a clean extension of the existing ProcurClient pattern.

**(c) Match-quality analytics view + tooling:**

```sql
CREATE OR REPLACE VIEW match_signal_performance AS
WITH outcomes AS (
  SELECT
    signal_kind,
    COUNT(*) FILTER (WHERE matched_at >= NOW() - INTERVAL '90 days') AS total_90d,
    COUNT(*) FILTER (WHERE matched_at >= NOW() - INTERVAL '90 days'
                     AND status IN ('pushed-to-vex', 'actioned')) AS actioned_90d,
    COUNT(*) FILTER (WHERE matched_at >= NOW() - INTERVAL '90 days'
                     AND deal_outcome = 'closed_won') AS closed_won_90d,
    AVG(realized_margin_usd) FILTER (WHERE deal_outcome = 'closed_won') AS avg_margin_won
  FROM match_queue
  GROUP BY signal_kind
)
SELECT
  signal_kind,
  total_90d,
  actioned_90d,
  closed_won_90d,
  ROUND((actioned_90d::numeric / NULLIF(total_90d, 0)) * 100, 1) AS action_rate_pct,
  ROUND((closed_won_90d::numeric / NULLIF(total_90d, 0)) * 100, 2) AS close_rate_pct,
  avg_margin_won
FROM outcomes
ORDER BY close_rate_pct DESC NULLS LAST;
```

This is the data that calibrates the scoring algorithm. After 90 days of operation, you'd see things like:

| signal_kind | total_90d | actioned | closed | action% | close% | avg_margin |
|---|---|---|---|---|---|---|
| `velocity_drop` | 47 | 23 | 6 | 49% | 12.8% | $84,200 |
| `bankruptcy_filing` | 12 | 4 | 1 | 33% | 8.3% | $145,000 |
| `press_distress_signal` | 31 | 8 | 1 | 26% | 3.2% | $35,000 |
| `sec_filing_offtake_change` | 19 | 9 | 3 | 47% | 15.8% | $112,000 |
| `leadership_change` | 23 | 5 | 0 | 22% | 0.0% | NULL |

The scoring engine uses these conversion rates to weight signal contributions. The system prompt's match-presentation discipline references these patterns explicitly ("leadership changes have historically converted to deals at low rates; surface only when paired with capability match"). The operator has empirical data about which signals are worth their attention.

### 4.3 What this enables

**Calibrated scoring.** After 90 days, the matching engine knows which signal types reliably surface real opportunities and which are noise. The static initial weighting ("velocity drops are interesting, distress events are interesting") gets replaced with empirical weighting ("velocity drops paired with category match convert at 18%; isolated distress events convert at 4%").

**Operator culture reinforcement.** The discipline rules in `strategic-vision.md` §9 — defend signal quality, don't broaden signals to generate more matches — become operationally measurable. If a tightening of signals causes close-rate to fall, the data shows it. If a relaxation causes close-rate to fall, the data shows that too.

**Strategic insight into VTC's actual deal patterns.** After 6 months, the data shows which kinds of signals actually drive VTC's closed deals. This informs strategy beyond just the matching engine — it shapes which intelligence sources to invest in, which counterparty types to prioritize, which discipline rules are paying off.

### 4.4 Edge cases and limitations

- **Attribution is harder than it looks.** A deal that closes 60 days after a match was pushed may or may not have been *caused* by the match. The deal might have happened anyway through a different path. The metric captures correlation, not causation. Treat the data as directional, not definitive.
- **The 90-day window is heuristic.** Some deals take longer; some materialize faster. The aggregation is windowed at 90 days as a default; longer-cycle deals (specialty crude, ~120-180 days from match to close) appear in the data eventually but with longer lag. For specialty crude specifically, a 180-day window is more appropriate; this is configurable in the analytics view.
- **No-engagement marking is approximate.** Vex marks a push as "no_engagement" after 90 days without an introductory call. This catches matches that were pushed but never seriously pursued; it doesn't perfectly distinguish "we tried and they didn't engage" from "we never tried." Operator judgment fills the gap when reviewing the data.

---

## 5. Work item 4: Vessel positions × cargo trips × entity activity

**Strategic value:** Medium-high. Depends on whether cargo trip inference is currently structured (commit messages reference shipping it; need to verify schema state). If the inference is structured, the work is wiring it to entity profiles; if not, the work is structuring the inference + wiring.

**Estimated effort:** 1 day if inference exists; 3-5 days if inference needs to be built

**Strategic priority:** 4 of 5

### 5.1 The problem

You have `vessels` (registry, MMSI/IMO/name/type/flag/DWT), `vessel_positions` (high-frequency AIS reports), and `ports` (geofenced terminals linked to entities where applicable). Commit messages reference cargo trip inference (pairing load↔discharge port calls into trips) — but the schema directory doesn't show a dedicated `cargo_trips` table.

This means cargo trips are either (a) computed at query time on demand, (b) materialized in some other table I haven't fully inspected, or (c) not yet shipped. Each of these scenarios has a different remediation:

- **(a) computed at query time:** the analytical capability exists but the user-facing surface (entity profiles showing "vessels arriving in last 90 days, inferred cargoes") doesn't. The work is wiring the existing computation to the UI and assistant tools.
- **(b) materialized elsewhere:** same as (a) but with name-discovery first.
- **(c) not yet shipped:** the work is implementing the inference + wiring. Larger scope.

**This brief assumes the most adversarial case (c)** and specifies the work for that scenario. If (a) or (b) turns out to be true, scope drops to ~1 day of UI wiring.

### 5.2 The solution

Three deliverables:

**(a) `cargo_trips` table** capturing pair-wise port-call inferences:

```typescript
export const cargoTrips = pgTable('cargo_trips', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Vessel that performed the trip. FK to vessels.mmsi. */
  mmsi: text('mmsi').notNull().references(() => vessels.mmsi),

  /** Loading port-call. */
  loadPortSlug: text('load_port_slug').notNull().references(() => ports.slug),
  loadStartedAt: timestamp('load_started_at').notNull(),
  loadCompletedAt: timestamp('load_completed_at').notNull(),

  /** Discharge port-call. */
  dischargePortSlug: text('discharge_port_slug').notNull().references(() => ports.slug),
  dischargeStartedAt: timestamp('discharge_started_at').notNull(),
  dischargeCompletedAt: timestamp('discharge_completed_at').notNull(),

  /** Inferred grade from loadPortSlug.knownGrades intersected with
   *  vessel type. NULL when grade is ambiguous. */
  inferredGradeSlug: text('inferred_grade_slug'),

  /** Inferred volume in barrels. Estimated from vessel DWT × typical
   *  fill factor for the route + grade. NULL when too uncertain. */
  inferredVolumeBbl: numeric('inferred_volume_bbl', { precision: 14, scale: 2 }),

  /** 0.0-1.0 confidence in the trip pairing. Drops with longer
   *  gaps between load discharge, intermediate port calls, etc. */
  confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),

  /** Voyage distance in nautical miles. */
  voyageNm: numeric('voyage_nm', { precision: 10, scale: 1 }),
  /** Voyage duration in hours. */
  voyageHours: numeric('voyage_hours', { precision: 10, scale: 1 }),

  inferredAt: timestamp('inferred_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  mmsiIdx: index('cargo_trips_mmsi_idx').on(table.mmsi),
  loadPortIdx: index('cargo_trips_load_port_idx').on(table.loadPortSlug),
  dischargePortIdx: index('cargo_trips_discharge_port_idx').on(table.dischargePortSlug),
  loadStartedIdx: index('cargo_trips_load_started_idx').on(table.loadStartedAt),
}));
```

**(b) Inference job** that runs nightly, walks `vessel_positions` for tankers, identifies port-call sequences (slow-moving in port geofence → underway → slow-moving in port geofence), and writes `cargo_trips` rows:

The inference algorithm:
1. For each tanker (`shipTypeLabel IN ('crude-tanker', 'product-tanker')`), get the sequence of position reports in the last 90 days
2. Identify "in-port" intervals (positions inside any port's geofence radius with `speedKnots < 1.0` for >2 hours)
3. Pair consecutive in-port intervals into trips: load = first interval, discharge = next interval, with constraints (different ports, time gap consistent with voyage at 12-15 knot average)
4. Look up `loadPortSlug.knownGrades` to infer cargo grade; if multiple grades are loaded at the port, leave grade NULL
5. Estimate volume from vessel DWT × 0.95 (typical fill factor) × 7.33 (bbl/MT for crude, varies by grade)
6. Compute confidence from voyage-pattern fit: high for direct ballast-then-laden voyages with consistent speed, low for trips with multiple intermediate stops

This runs in roughly 1-2 hours nightly given the current AIS volume; scales to ~6 hours if AIS coverage expands further.

**(c) Entity activity panels:**

For refineries: a "Recent vessel activity" panel showing the last 90 days of cargoes received (inferred). Aggregate stats (total volume, tanker count, average DWT, top origin countries, grade distribution) plus a list of individual trips with vessel name, load port, discharge port, dates, inferred grade, confidence.

For producing-country marketing arms / loading terminals: a "Recent cargoes loaded" panel. Same shape but inverted — what loaded from the producer's terminal, where it discharged.

A new assistant tool:

```typescript
analyze_entity_cargo_activity(args: {
  entitySlug: string;
  windowDays?: number;  // default 90
}) => CargoActivitySummary
```

Returns a structured summary: total volume, trip count, origin/destination distribution, grade distribution, month-over-month trend.

### 5.3 What this enables

**Empirical procurement behavior on every refinery.** Outreach messages can reference actual observed cargo arrivals: *"I see your facility has received approximately 14 tankers in the last 90 days, averaging 105K DWT, with origin distribution heavily weighted toward [X]. We have visibility into [grade] cargoes that would diversify that profile..."*

**Equity oil placement intelligence.** For producing-country marketing arms, the cargo loading data shows where their crude actually goes. A Sonatrach with Es Sider loading patterns shifting away from Mediterranean traditional buyers tells a different story than one with stable patterns. The `entity_news_events` distress signals layer combined with cargo-flow shifts is much more informative than either alone.

**Trade opportunity identification.** When a refinery's cargo pattern shifts (origin diversification, volume increase, grade shift), it's often visible in AIS before it's visible in news or trade press. This is exactly the "private signal earlier than public signal" thesis the strategic-vision document was built on.

### 5.4 Edge cases and limitations

- **Inferred grade is approximate.** Many ports load multiple grades; grade inference is reliable only for single-grade terminals or when the vessel's prior cargo history adds context. Tool documentation flags this clearly.
- **Volume inference depends on vessel data quality.** DWT is sometimes missing; fill factor varies by route and grade. Inferred volumes are estimates with ±15% typical error; useful directionally, not absolutely.
- **Coverage is limited to AIS bounding boxes.** Trips entirely outside the configured Mediterranean / Caribbean / US Gulf / West Africa boxes are invisible. As coverage expands, more trips become visible.
- **STS transfers are partially captured.** Ship-to-ship transfers in offshore zones may not be classified as port calls. The inference flags these as low-confidence trips; refinement is a future enhancement.

---

## 6. Work item 5: Customs flow data × entity profile context

**Strategic value:** Medium. Strong for outreach specificity ("we know things about your business") but operationally less central than the first three items.

**Estimated effort:** 1 day

**Strategic priority:** 5 of 5

### 6.1 The problem

You have `customs_imports` (Eurostat Comext) covering aggregate import flows by reporter country / partner country / HS code / period. The data is good for country-level analysis. **It doesn't connect to specific entities in your rolodex.**

When you look at a Caribbean refinery's profile, you can read the rolodex notes about the entity, but you can't see the macro context: what is the overall trade flow into this refinery's country for the relevant products? How has it shifted over the last 12 months? This context anchors the refinery in its actual market environment rather than just its individual properties.

For producer marketing arms, the inverse: where does the country's product *actually go* in aggregate? The flow patterns are observable from customs reporting; they just don't surface on the entity profile.

### 6.2 The solution

Three deliverables:

**(a) Entity → customs-context mapping.** A new field on `known_entities.metadata`:

```typescript
interface CustomsContextMapping {
  /** When entity is a refinery: maps to import flows into its country. */
  importContext?: {
    reporterCountry: string;  // ISO-2
    productCodeRanges: string[];  // HS code prefixes, e.g. ["2709", "2710"]
    relevanceLabel: string;  // e.g. "Crude oil and refined products"
  };

  /** When entity is a producer/marketing-arm: maps to export flows. */
  exportContext?: {
    partnerCountry: string;  // ISO-2 — country of origin
    productCodeRanges: string[];
    relevanceLabel: string;
  };
}
```

For the top 60-80 entities (Tier 1 refineries plus the bilateral counterparties for specialty crude), populate this mapping from the rolodex. A refinery in DR gets `importContext: { reporterCountry: 'DO', productCodeRanges: ['2710'], relevanceLabel: 'Refined petroleum products' }`. A Sonatrach gets `exportContext: { partnerCountry: 'DZ', productCodeRanges: ['2709'], relevanceLabel: 'Crude oil exports' }`.

**(b) Assistant tool:**

```typescript
analyze_country_trade_pattern(args: {
  entitySlug: string;
  /** How far back to fetch customs data. Default 24 months. */
  windowMonths?: number;
}) => CountryTradePattern
```

Returns: total volume / value over the window, month-over-month trend, top trading partners, year-over-year comparison, structural shifts visible in the data.

**(c) Entity profile panel:**

For refineries: "Country trade context" panel showing imports into the refinery's country for relevant HS codes. Volume + value over time, top supplier countries (which are where competitive supply comes from), seasonal patterns.

For producers: same panel inverted — exports from the producer's country for the relevant HS codes. Top destination countries (which is where their crude actually goes), volume trends.

### 6.3 What this enables

**Country-level outreach specificity.** Messages like *"I see Italy's refined product imports from Algeria have declined ~14% YoY over the last 12 months, while imports from Russia increased 22%. Your specific refinery's procurement pattern likely reflects this, but I'm curious how it's affecting your near-term sourcing flexibility..."* This isn't tabloid-level macro analysis; it's specific data anchored to the counterparty's actual context.

**Validation of cargo-flow inferences.** The vessel-trips data from work item 4 shows specific cargoes; the customs data validates the macro pattern. When the two diverge, that's information — possibly indicating cargo flows VTC's AIS bounding boxes don't cover, or grade reclassification, or trade-flow rerouting. Cross-validation strengthens both data sources.

**Equity oil placement context.** For producing-country marketing arms, the customs-flow data shows where their crude actually exports to in aggregate. Combined with the cargo-trip data (specific cargoes) and the news events data (announcements about contract changes), you have a three-dimensional view of the producer's commercial activity that no small competitor has access to.

### 6.4 Edge cases and limitations

- **Eurostat covers EU reporters.** Imports into EU countries are visible; imports into Caribbean, Latin American, West African countries from EU producers are visible from the EU side. **Caribbean-to-Caribbean and Caribbean-to-Latin-America flows are not in Eurostat at all.** UN Comtrade has broader coverage but with longer lag and lower granularity. For Caribbean-internal trade, customs data is meaningfully incomplete.
- **HS code aggregation hides product detail.** HS code 2710 covers "petroleum oils, other than crude" — diesel, gasoline, jet, fuel oil all aggregate together at the 4-digit level. 6-digit detail (271019, 271020, etc.) helps but Eurostat coverage at 8-digit detail varies. For specific product analysis, the HS aggregation is a real limitation.
- **Customs reporting lags 2-3 months.** Recent flows aren't visible immediately; the data is most useful for 12-24-month pattern analysis, not for real-time signal.

---

## 7. Two near-misses worth flagging

These aren't gaps in the same way as the five work items above — they're places where the data is present but the connection is more subtle. Lower priority but worth flagging for completeness.

### 7.1 Awards × ownership graph for "real winner" consolidation

When `award_awardees` records the named winner of a contract, the named entity is often a regional subsidiary or local affiliate of a larger group. For competitive landscape purposes, the ultimate parent is the *real* winner.

The DR Caribbean fuel analysis manually identified Coral + Next = Grupo Propagas, $247M combined. With ownership-aware queries (work item 2), this consolidation happens automatically across all jurisdictions and all award histories.

The work is roughly: extend the supplier-graph analytical tools to optionally aggregate by `entity_ownership.parent` rather than by named awardee. Not a separate work item — it's a free byproduct of work item 2 once the ownership tools exist. **Ship it as part of work item 2's scope.**

### 7.2 Crude assay per-cut yields for product-economics modeling

`crude_assay_cuts` has detailed yield breakdowns per crude grade. This data is rich. Currently it's surfaced as reference (the assay panel on a grade page) but not used computationally.

The opportunity: combine assay yields × current product prices × refinery configuration to estimate refining margin per barrel for any (grade, refinery) pair. This tells you the *maximum sustainable price* a refinery would pay for a given grade before economics break. For specialty crude brokerage, this is the structural pricing logic.

The work is an assistant tool:

```typescript
calculate_refining_economics(args: {
  gradeSlug: string;
  refinerySlug: string;
  /** Optional override for product pricing assumptions. */
  productPriceOverrides?: Record<string, number>;
}) => RefiningEconomicsEstimate
```

Returns: gross product worth per barrel (sum of yields × spot prices), estimated processing cost per barrel (function of refinery complexity index), implied maximum crude price (gross product worth - processing cost - target margin), and the differential to current crude pricing.

This is roughly 1 day of work given all the inputs are present (assay yields, product prices in `commodity_prices`, complexity indexes from work item 1). **Defer this until work item 1 is shipped** — it depends on the structured slate metadata.

---

## 8. Implementation order and timing

Recommended sequence:

1. **Work item 1** (slate-fit) — foundational for specialty crude track, unlocks most strategic value. Days 1-3.
2. **Work item 2** (ownership wiring) — fastest to ship for the value delivered. Days 4-5.
3. **Work item 3** (match queue feedback) — operational discipline that compounds over time. Days 6-7.
4. **Work item 4** (cargo trips × entity activity) — depends on whether inference is already structured. Days 8-12 worst case.
5. **Work item 5** (customs context) — incremental value, low effort, schedule when convenient. Day 13.

**Total: ~13 days of focused work** to close all five connections, plus the two near-misses which fold in opportunistically.

This is the kind of work that compounds. Each connection makes the next one more powerful. Slate-fit + ownership = grade-matched outreach to the right person at the parent entity. Slate-fit + cargo-trips = "we have a grade that fits your slate, and here's the empirical evidence of your current procurement pattern." Match queue feedback + everything else = the scoring engine learns which combinations of signals actually drive deals.

---

## 9. What this brief deliberately doesn't include

- **No new ingestion sources.** Every data source referenced here is already loaded. Adding more sources is a separate question; the value being claimed in this brief comes from connections, not coverage.
- **No new architectural patterns.** All the schema additions follow existing conventions (snake_case columns, `*_idx` indexes, `metadata jsonb` for extension fields). All the assistant tools follow the existing tool registration patterns. Nothing here requires new infrastructure.
- **No tenant scoping changes.** All five connections operate on the existing public-domain tables with the existing visibility model. The tenant-scoping discussion for `supplier_signals` (already flagged in that schema's comments) remains a separate workstream.
- **No vex-side changes beyond work item 3.** Procur is the canonical home for all five connections. Vex consumes work item 1's slate-fit tools through the existing intelligence HTTP API; vex emits the match outcome webhook for work item 3. Otherwise vex is unchanged.

---

## 10. Why this work matters more than building new ingestion

The instinct after seeing what's been built is to add more data sources. Add SEDAR. Add LinkedIn Sales Navigator. Add OilPriceAPI subscription. Add Kpler. Add Vortexa.

**That instinct is correct in the long run and wrong in the short run.** Procur has 50+ schema tables; each contains rich data; the marginal value of a 51st table is much smaller than the marginal value of properly connecting tables 1-50. Specifically: every connection in this brief surfaces analytical capability that data already in the warehouse can produce *but currently doesn't*. The ROI on connection work is dramatically higher than the ROI on additional ingestion at this stage.

Once these five connections are live, you have:

- A grade-matching engine that produces empirically-defensible matches between any crude grade and any refinery in the rolodex
- An ownership graph that surfaces sovereign exposure, consolidation patterns, and sanctions cascades automatically
- A feedback loop that calibrates the match queue's scoring against actual deal outcomes
- Cargo-flow intelligence that anchors every counterparty in observable procurement behavior
- Country-trade context that anchors every counterparty in their macro environment

That's the analytical depth that makes the commercial-strategy and specialty-crude-strategy claims real. **The data already supports those claims; the connections in this brief are what makes the system actually deliver on them.**

---

End of data graph connections brief.
