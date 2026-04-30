# Specialty Crude Strategy — Pointer

**Canonical document:** [`cjkootch/vex` → `docs/specialty-crude-strategy.md`](https://github.com/cjkootch/vex/blob/main/docs/specialty-crude-strategy.md)

The canonical specialty crude strategy lives in vex because:

1. The bulk of the specialty crude execution work happens in vex
   (compliance routing, transaction templates, counterparty graph,
   approval gates).
2. The strategic backbone is read primarily by operators making
   commercial decisions, who work primarily in vex.
3. The pattern matches the existing brief structure (canonical
   strategy documents in vex, pointers in procur).

## What procur provides for the specialty crude track

- The bilateral counterparty research surface (existing tools:
  `analyze_supplier`, `find_competing_sellers`, web search,
  entity_news_events)
- The grade-matching analytical infrastructure
  (`crude_grades` table, `lookup_refineries_compatible_with_grade`,
  refinery slate-fit data on `known_entities.metadata.slate`)
- The cargo intelligence layer (vessel positions, port calls,
  cargo trip inference)
- The discount market pricing observations once that workstream
  is active (extension of existing pricing analytics)

## What procur does NOT provide

- No compliance-route evaluation logic — that lives in vex
- No transaction templates — that lives in vex
- No deal-level counterparty engagement — that lives in vex
- No specialty crude executions are recorded in procur — they
  flow through vex's `fuel_deals` (or future crude-specific
  schema) which is tenant-private

## The Pattern A boundary

The specialty crude track does not include trade finance to
counterparties. The boundary established in
`docs/origination-partners-brief.md` §2 (Pattern A out of scope)
applies to specialty crude operations as well. No trade finance
features in procur, ever, regardless of how the strategy evolves.

If VTC ever pursues Pattern A as a separate business line, it
gets a separate system. Not this one.

## Companion documents

- `docs/strategic-vision.md` — overall technical vision
- `docs/vex-commercial-strategy-pointer.md` — VTC's broader
  commercial frame
- `docs/vex-specialty-crude-30day-pointer.md` — the operational
  30-day plan that executes against this strategic backbone

See cjkootch/vex/docs/specialty-crude-strategy.md for full document.
