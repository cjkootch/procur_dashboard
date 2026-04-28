# Vex × Procur Integration

**Canonical brief:** [`cjkootch/vex` → `docs/procur-integration.md`](https://github.com/cjkootch/vex/blob/main/docs/procur-integration.md)

This file is a pointer. The canonical integration brief lives in the
vex repo because the bulk of the integration work happens there
(new agents, new schema, new HTTP client). Procur's role in the
integration is small and well-bounded:

## What procur exposes for vex consumption

A minimal HTTP read API under `apps/app/app/api/intelligence/`,
wrapping the existing assistant tools registered in
`packages/catalog/src/tools.ts`:

```
GET  /intelligence/supplier/:idOrName           -> analyze_supplier
GET  /intelligence/supplier/:idOrName/pricing   -> analyze_supplier_pricing
GET  /intelligence/cargoes                      -> find_recent_cargoes
GET  /intelligence/distressed-suppliers         -> find_distressed_suppliers
POST /intelligence/find-buyers                  -> find_buyers_for_offer
POST /intelligence/find-suppliers-for-tender    -> find_suppliers_for_tender
POST /intelligence/evaluate-offer               -> evaluate_offer_against_history
GET  /intelligence/buyer-pricing                -> analyze_buyer_pricing
GET  /intelligence/entity-news/:entitySlug      -> entity_news_events for entity
```

Auth: bearer token, service-to-service. Issue a long-lived token
to vex; verify on every request.

## What procur deliberately does NOT do

- No bidirectional sync. Vex's private behavioral data stays in vex.
- No federated DB access from vex. HTTP boundary is permanent.
- No callbacks into vex. Procur stays stateless from vex's perspective.

## Order of operations

The HTTP API surface in procur (item 1 in the canonical brief's
implementation order) is the only procur-side work. Estimated
~1 day of work. Everything else happens in vex.

For full architecture context, decision rationale, schema additions,
agent specs, and the three-message playbook this enables, see the
canonical brief linked above.
