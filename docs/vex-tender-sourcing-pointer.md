# Tender-Sourcing Integration — Procur Side

**Canonical brief:** [`cjkootch/vex` → `docs/tender-sourcing-addendum.md`](https://github.com/cjkootch/vex/blob/main/docs/tender-sourcing-addendum.md)

This file documents procur's responsibilities for the tender-sourcing
integration. The canonical brief lives in vex because most of the work
(new schema, three new agents, new UI surface) happens there.

## What procur exposes for vex tender-sourcing consumption

Three additions to the existing intelligence HTTP API
(`apps/app/app/api/intelligence/`):

```
GET  /intelligence/proximity-suppliers
       ?category_tag=...
       &destination_lat=...&destination_lon=...
       &radius_nm=...
       &roles=producer,refiner,trader
       &limit=...

  Returns known_entities filtered by haversine distance to a
  destination port, with role + capability + tags. Powers Tier 1 +
  Tier 2 of the three-tier supplier discovery.

GET  /intelligence/opportunities/recent
       ?since=<iso8601>
       &category_tags=<comma-list>
       &beneficiary_countries=<comma-list>
       &volume_mt_min=...&volume_mt_max=...
       &limit=...

  Returns recent procur opportunities matching the bid-criteria
  filters. Consumed by ProcurOpportunityWatcher in vex on a cron
  schedule.

POST /intelligence/find-suppliers-for-tender    [EXTENSION]
  Add an optional `originBias: { lat, lon, weightFactor }` parameter
  to boost candidates whose country is geographically close to the
  bias point. Powers Tier 3 ranking.
```

## What procur deliberately does NOT do

- No bid composition (vex assembles bids; procur surfaces candidates)
- No tender pricing prediction (separate v2 feature)
- No automated supplier disqualification (operator decides)
- No tender outcome tracking (lives in vex, not procur)

## Schema prerequisite

`known_entities` rows must have `latitude` and `longitude` populated
for the entity universe relevant to VTC's bid criteria. This may
require a backfill pass (research script + manual curation) before
proximity queries return useful results. Currently the column exists
but population is partial.

## Order of operations

The three new endpoints are ~1.5 days of procur-side work. Everything
else happens in vex. See the canonical brief for full implementation
order, schema specs, agent specs, and the end-to-end playbook.
