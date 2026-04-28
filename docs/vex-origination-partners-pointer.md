# Origination Partners — Procur Side

**Canonical brief:** [`cjkootch/vex` → `docs/origination-partners-brief.md`](https://github.com/cjkootch/vex/blob/main/docs/origination-partners-brief.md)

This file documents procur's responsibilities for the origination
partners workflow. The canonical brief lives in vex because all the
substantive work (partner schema, KYC tracking, vetting workflow,
discipline rules, partner-facing intake surface) happens there.

## What procur does for this workflow

Procur is purely a **signal source** for partner candidate
identification. No new procur endpoints are needed. The vex-side
`OriginationPartnerScoutAgent` consumes existing procur HTTP endpoints
to find candidates matching the partner profile:

- `find_distressed_suppliers` filtered to small-volume award patterns
- `find_recent_cargoes` for entities active in VTC's geographies
- `analyze_supplier` (per candidate, during vetting research)
- `entity_news_events` (during enhanced KYC dimension: adverse media)
- Existing tender-bidder data (entities that bid but didn't win — i.e.
  have buyer relationships but lack execution capability)

## What procur explicitly does NOT do

- No partner-tier relationship modeling (lives in vex)
- No KYC tracking (lives in vex)
- No partner-facing surface (lives in vex)
- No deal intake form (lives in vex)
- No fee structure or payment tracking (lives in vex)
- **No trade finance product or feature.** Pattern A is explicitly
  out of scope across both repos. If anyone proposes adding capital-
  extension features to either system, see §2 and §9 of the canonical
  brief.

## The Pattern A boundary applies to procur too

The boundary is not specific to vex. Procur should not develop
features that suggest extending capital to counterparties — no
"trade finance scoring," no "credit exposure aggregation," no
"working capital recommendations." Procur's role is intelligence on
public counterparties; vex's role is execution. Neither role
includes capital extension to partners.

If VTC ever pursues Pattern A as a separate business line, that
business gets a new system. Not this one.

See cjkootch/vex/docs/origination-partners-brief.md for full spec.
