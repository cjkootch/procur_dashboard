# Apollo.io Integration — Org Enrichment, Discovery, and Hiring/Funding Signals

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-05
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/data-graph-connections-brief.md` (the existing-data joins this brief layers external enrichment onto), `docs/intelligence-layers-brief.md` (the broader signal-source taxonomy this slots into), `docs/supplier-graph-brief.md` (the rolodex/external-suppliers schema this enriches), `docs/strategic-vision.md`

This brief specifies how Apollo.io's organization API gets wired into procur to enrich existing rolodex entities, batch-seed new ones from criteria-driven searches, and surface hiring/funding signals as alert-able events. Apollo is treated as one external signal source among several — it does not become a system of record, and its data does not silently shadow the curated rolodex layer.

The work is bounded: 1 migration adding domain + Apollo cache columns to two tables, 1 service package, 1 nightly cron, 3 chat tools, and a handful of UI surfaces that read the cached snapshot. Estimated effort: **3–5 days** depending on UI scope.

---

## 1. Why this brief exists

Procur's rolodex (`known_entities`) and scraped-supplier layer (`external_suppliers`) capture **what an analyst knows** and **what public portals have published**, respectively. Neither captures the **commercial/financial context** of the entity:

- How big is the company in headcount, today and 24 months ago?
- What's its revenue band? Has it raised recently? At what stage?
- What technology stack does it run? (Useful proxy for sophistication and integration cost.)
- Is it hiring sales / commercial roles right now? (Signal of go-to-market expansion.)
- Have any of *our watched suppliers* raised in the last 30 days? (Signal of capital-driven aggression.)

Today, an operator answers these questions by leaving procur, opening a browser, searching, and copy-pasting findings into deal notes. Apollo's API exposes all of the above behind two endpoints — `GET /organizations/{id}` (single-org, requires master key) and `POST /mixed_companies/search` (filter-based discovery). Wiring both into procur eliminates the browser detour and makes the data queryable, alert-able, and visible at the surfaces where deal decisions actually get made: entity profiles, the rolodex, and `/alerts`.

Three operational gaps this closes:

**(a) Trade-finance risk read.** A supplier that just closed Series D is a different counterparty from one that hasn't raised in 3 years. Procur today cannot show that distinction. With funding fields cached on the entity, the entity profile leads with the relevant signal.

**(b) Rolodex seeding is hand-curation only.** The 73 Caribbean fuel buyers were hand-typed. The `q_organization_keyword_tags` + `organization_locations` filters in the search endpoint return that candidate set in one API call. Hand-curation stays in the loop for editorial judgment, but it stops being the bottleneck for *coverage*.

**(c) Hiring and funding signals don't flow into `/alerts`.** When a watched competitor raises a Series C or starts hiring a Caribbean trading desk, that's an event the operator wants pinged — same alert lane as award notices and KYC expirations. Apollo's filter parameters (`latest_funding_date_range`, `q_organization_job_titles`, `organization_job_locations`) make those signals queryable on a schedule.

---

## 2. Scope and non-scope

### 2.1 In scope

- Domain field added to `known_entities` and `external_suppliers` (precondition for any external enrichment, not Apollo-specific)
- Apollo cache columns + jsonb snapshot on both entity tables
- A `@procur/apollo` service package wrapping the two Apollo endpoints, with credit-aware rate limiting, response caching, and a typed result shape
- Nightly batch-enrichment cron that pulls funding/headcount/revenue snapshots for the rolodex via the 1,000-domains-per-call search endpoint
- On-demand single-org enrichment via the `GET /organizations/{id}` endpoint, gated by the master API key, used when an operator opens an entity profile and the cache is older than the freshness threshold
- Three chat tools: `lookup_apollo_org`, `discover_orgs_by_criteria`, `find_recent_funding_events`
- Integration surfaces: entity profile (`/entities/[slug]`) shows funding + headcount-trend; rolodex (`/suppliers/known-entities`) shows funding-stage chip; `/alerts` surfaces saved-search hits
- Migration is forward-only; existing rows have `apollo_org_id = NULL` and get backfilled by the nightly job over the first week post-deploy

### 2.2 Out of scope

- **Apollo person/contact data.** Apollo also exposes person-level contact enrichment. Procur already has `entity_contact_enrichments`, and adding a second person enrichment source means reconciling them. Defer to a separate brief.
- **Intent signals.** Apollo's `intent_signal_account` block tracks B2B SaaS website visits. Useless for commodity counterparties (a Bahraini refinery is not visiting `tableofdiscontents.com`). Skipped on purpose, not deferred.
- **Apollo as a source of record.** The rolodex and external_suppliers tables remain authoritative for identity, role, categories, and analyst notes. Apollo populates a *snapshot* column; the snapshot is treated as enrichment, not truth.
- **Backfilling all 5,982 awards' awardees.** Apollo enrichment runs against rolodex entities first. Award-side enrichment is a separate decision once the rolodex case is proven.
- **Counterparty matching for non-corporate entities.** Apollo won't have ministries, state-owned authorities, refineries that lack a `.com` domain, or freight brokers that operate via personal phones. The integration silently degrades for these — `apollo_org_id IS NULL` and the UI surfaces "Apollo: not matched" without erroring.
- **Multi-tenant Apollo accounts.** v1 uses a single Apollo master key for all of procur. Per-tenant Apollo credentials are out of scope.

### 2.3 Why this is a brief and not a one-off

Apollo's API surface is broad and the temptation is to wire each endpoint up ad-hoc as a use case appears. That route produces three separate code paths that all hit Apollo, three separate caching strategies, three separate ways credits get burned, and no consistent shape for the data downstream. This brief defines the schema, service, and cache discipline once so every use case rides the same rails.

---

## 3. Apollo endpoints in scope and what they give us

Apollo's organization-level surface has two endpoints we'll use. Brief summary of fields procur cares about, since the Apollo OpenAPI is broad:

### 3.1 `GET /organizations/{id}` — single-org full enrichment

**Requires:** master API key (gated by Apollo plan). 403 without it.
**Cost:** consumes credits per call.
**Use when:** an operator opens an entity profile and the cached snapshot is missing or stale (>30 days).

Fields procur consumes:
- `id`, `primary_domain`, `name`, `linkedin_url`, `founded_year`
- `industry`, `industries`, `keywords[]`
- `estimated_num_employees`, `annual_revenue`, `annual_revenue_printed`
- `total_funding`, `total_funding_printed`, `latest_funding_round_date`, `latest_funding_stage`
- `funding_events[]` — the per-round breakdown with date / type / investors / amount
- `technology_names[]` and `current_technologies[]`
- `employee_metrics[]` — monthly department-level new/retained/churned counts (24+ months retained on cache)
- `raw_address`, `street_address`, `city`, `state`, `postal_code`, `country`
- `short_description` (LLM-generated company summary; useful for the chat assistant when no analyst notes exist)

Discarded:
- `intent_signal_account`, `account` (B2B-SaaS-tuned, not relevant)
- `org_chart_*` (needs people endpoint to be useful)
- `suborganizations` (defer to multi-entity reconciliation work)

### 3.2 `POST /mixed_companies/search` — criteria-driven discovery + batch enrichment

**Cost:** consumes credits per page returned.
**Rate limit:** 600 calls/hr.
**Display limit:** 50,000 records max per query (100/page × 500 pages).

Two distinct uses:

**Batch enrichment.** `q_organization_domains_list[]` accepts up to **1,000 domains per call**. The nightly job batches the rolodex's distinct domains into chunks of 1,000 and pulls the resulting orgs. One call covers ~1,000 entities.

**Discovery.** Operator-driven or saved-search:
- `q_organization_keyword_tags[]` — finds e.g. all "fuel distribution" companies
- `organization_locations[]` / `organization_not_locations[]` — geographic targeting
- `organization_num_employees_ranges[]` — headcount bands
- `revenue_range[min/max]` — revenue bands
- `latest_funding_date_range[min/max]` + `total_funding_range[min/max]` — funding-recency / funding-size signals
- `q_organization_job_titles[]` + `organization_job_locations[]` + `organization_job_posted_at_range[min/max]` — hiring signals

Note: the search endpoint returns a thinner organization shape than the single-get. Critically, it does NOT return `funding_events[]`, `employee_metrics[]`, or the technology breakdown. Those require a follow-up `GET /organizations/{id}` per org — so the cron does a two-stage flow:
1. Nightly batch-enrichment search by 1,000-domain chunks → cache thin snapshot, capture `apollo_org_id`
2. On-demand single-get when an operator opens the entity profile → cache full snapshot

---

## 4. Schema additions

### 4.1 Domain field (precondition, not Apollo-specific)

`known_entities` and `external_suppliers` get a stable domain column:

```sql
ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS primary_domain text;
ALTER TABLE external_suppliers
  ADD COLUMN IF NOT EXISTS primary_domain text;

CREATE INDEX IF NOT EXISTS known_entities_primary_domain_idx
  ON known_entities (primary_domain);
CREATE INDEX IF NOT EXISTS external_suppliers_primary_domain_idx
  ON external_suppliers (primary_domain);
```

Domain is the identity key for every external corporate-data API procur is likely to integrate with (Apollo, Clearbit, OpenCorporates, Sayari). Adding it now keeps the surface API-agnostic. Existing rows backfill via:
- Manual analyst entry where the domain is known
- A one-shot domain-extraction pass over `metadata.website` / `notes` text where present
- Apollo enrichment itself (one-way: search by name → match → write back)

The column is nullable; entities without a domain (ministries, state authorities, individual brokers) stay unmatched and that's fine.

### 4.2 Apollo cache columns

```sql
ALTER TABLE known_entities
  ADD COLUMN IF NOT EXISTS apollo_org_id text,
  ADD COLUMN IF NOT EXISTS apollo_synced_at timestamp,
  ADD COLUMN IF NOT EXISTS apollo_funding_stage text,
  ADD COLUMN IF NOT EXISTS apollo_total_funding bigint,
  ADD COLUMN IF NOT EXISTS apollo_latest_funding_at date,
  ADD COLUMN IF NOT EXISTS apollo_estimated_employees integer,
  ADD COLUMN IF NOT EXISTS apollo_annual_revenue bigint,
  ADD COLUMN IF NOT EXISTS apollo_snapshot jsonb;

CREATE INDEX IF NOT EXISTS known_entities_apollo_org_id_idx
  ON known_entities (apollo_org_id);
CREATE INDEX IF NOT EXISTS known_entities_apollo_funding_stage_idx
  ON known_entities (apollo_funding_stage);
CREATE INDEX IF NOT EXISTS known_entities_apollo_latest_funding_at_idx
  ON known_entities (apollo_latest_funding_at);
```

Same shape on `external_suppliers`.

**Why hybrid (columns + jsonb).** Funding stage, total funding, headcount, latest-funding-date, and revenue are queryable filters in the rolodex UI and in chat tools — they need to be real columns to support `WHERE apollo_funding_stage = 'series-d'` and ordering by `apollo_latest_funding_at`. The 24 months of monthly per-department `employee_metrics`, the technology stack, the per-round funding breakdown, and the keyword vocabulary are wide and rarely queried — they live in `apollo_snapshot jsonb` and get rendered as needed.

The jsonb column also provides version tolerance: when Apollo adds a field to its response, we capture it without a migration.

### 4.3 Saved-search table for discovery alerts

```sql
CREATE TABLE apollo_saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  description text,

  /** The Apollo search filter as a JSON object — same shape the
      service-layer search function takes. */
  search_filters jsonb NOT NULL,

  /** When the operator wants to be alerted: 'on-new-match' fires
      whenever an org appears in results that wasn't there last run.
      'periodic' just runs on schedule and surfaces the full result
      set as a digest. */
  alert_mode text NOT NULL DEFAULT 'on-new-match',

  /** Cron expression or 'daily' / 'weekly' shorthand. */
  schedule text NOT NULL DEFAULT 'daily',

  /** Last-seen org IDs, used to compute "new since last run". */
  last_seen_org_ids text[] NOT NULL DEFAULT '{}',
  last_run_at timestamp,

  status text NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX apollo_saved_searches_company_idx
  ON apollo_saved_searches (company_id);
```

This table is per-tenant. The Apollo *credentials* are global; the *queries* are tenant-scoped because saved searches encode commercial intent.

---

## 5. Service layer architecture

A new `@procur/apollo` package, parallel to `@procur/catalog`. Three exported entry points:

```typescript
// packages/apollo/src/index.ts

/** Single-org enrichment via GET /organizations/{id}.
 *  Caches into known_entities or external_suppliers (whichever the
 *  caller passes). Skips the API call if synced_at is < freshness
 *  window. Returns null when Apollo has no record. */
export async function enrichOrgFromApollo(args: {
  apolloOrgId?: string;     // preferred, when known
  primaryDomain?: string;   // fallback, when apolloOrgId not yet matched
  freshnessHours?: number;  // default 24*30
}): Promise<ApolloOrgSnapshot | null>;

/** Batch enrichment via POST /mixed_companies/search with
 *  q_organization_domains_list. Used by the nightly cron and by ad-hoc
 *  bulk-import flows. Chunks input into 1,000-domain calls. Writes
 *  back the thin snapshot + apollo_org_id. */
export async function enrichOrgsBatch(args: {
  domains: string[];
  targetTable: 'known_entities' | 'external_suppliers';
}): Promise<{ matched: number; unmatched: string[]; creditsSpent: number }>;

/** Discovery search, operator-driven or saved. Returns the thin
 *  organization shape from the search endpoint. Does NOT auto-enrich
 *  to full snapshots (callers decide whether to follow up with
 *  enrichOrgFromApollo). */
export async function searchOrgs(
  filters: ApolloSearchFilters,
  opts?: { page?: number; perPage?: number },
): Promise<ApolloSearchResult>;
```

Internal:

- **Credential loading.** `APOLLO_MASTER_API_KEY` env var, plus a feature flag `APOLLO_ENABLED` defaulting to false outside production. Functions return null + a warning log when disabled, never throw.
- **Rate limiting.** Internal token bucket sized for 500 calls/hr (under the 600 limit). When the bucket is empty, batch-enrichment defers; on-demand enrichment returns the stale cache + a "rate-limited, try again in N minutes" flag.
- **Credit accounting.** Every call increments a counter persisted to `apollo_credit_log` (one row per call: endpoint, args hash, page, credits, timestamp). The `/admin/apollo` page shows the running monthly burn so we know what the integration costs.
- **Error handling.** 401 → log + raise; 403 → log + degrade (e.g. on master-key endpoints, mark integration disabled); 422 (bad ID) → return null; 429 → exponential backoff up to 4 attempts.

The package depends on `@procur/db` (for cache writes) and is consumed by `@procur/catalog` (for chat tools), the ai-pipeline service (for the cron), and the app (for entity-profile on-demand enrichment).

### 5.1 Where the cron lives

`services/ai-pipeline/src/jobs/apollo-batch-enrichment.ts`. Runs nightly at 02:00 UTC. Algorithm:

1. Pull every `(known_entities | external_suppliers) WHERE primary_domain IS NOT NULL AND (apollo_synced_at IS NULL OR apollo_synced_at < now() - INTERVAL '7 days')`.
2. Chunk domains into batches of 1,000.
3. For each chunk: call `searchOrgs` with `q_organization_domains_list = chunk`. Match returned orgs back to the rolodex by `primary_domain`. Write `apollo_org_id`, the column-backed fields, and the thin snapshot. Mark unmatched domains so they don't re-attempt every night.
4. Log credit spend.

The cron does NOT call the single-get endpoint; it stays in batch-mode to keep credit usage bounded. Single-get is on-demand only.

### 5.2 Saved-search runner

`services/ai-pipeline/src/jobs/apollo-saved-searches.ts`. Runs on the schedule each saved search defines. For each saved search:
1. Call `searchOrgs` with the saved filters.
2. Diff the returned org IDs against `last_seen_org_ids`.
3. New IDs → write rows into existing `alerts` table with type `apollo-saved-search-hit`, payload referencing the saved-search id and the new org details.
4. Update `last_seen_org_ids` and `last_run_at`.

---

## 6. Integration surfaces

### 6.1 Entity profile (`/entities/[slug]`)

Adds a "Corporate context" section between "Identity" and the existing "Recent activity":

```
Corporate context (Apollo)
─────────────────────────────────────────────
Founded         1947
Employees       ~5,200 (↑12% YoY)
Revenue         ~$45B
Latest funding  Public — TYO:8031
Tech stack      SAP, Salesforce, Microsoft 365
[ Refresh from Apollo ]
```

Below the static fields, a "Headcount trend" mini-chart pulled from `apollo_snapshot.employee_metrics[]` showing 24-month department-level new/retained/churned. The chart is collapsed-by-default; analysts who care expand it.

**Empty state:** when `apollo_org_id IS NULL`, the section renders "Apollo: no match. [ Search by name ]" — clicking calls `searchOrgs` with `q_organization_name` and shows a chooser if there are multiple matches. The chosen org ID writes back to `apollo_org_id` and triggers a single-get enrichment.

### 6.2 Rolodex (`/suppliers/known-entities`)

Adds an inline funding-stage chip on each row, alongside the existing approval-status chip. Sortable by `apollo_latest_funding_at DESC` to surface "who has capital right now" at the top.

URL filter: `?funding_stage=series-c-or-later`, `?revenue_min=50000000`, `?employee_min=500`. Same pattern as the existing approval filter.

### 6.3 Alerts (`/alerts`)

New alert type `apollo-saved-search-hit` rendered like other alerts but with a "View saved search" link that deep-links to `/settings/apollo-searches/[id]`.

### 6.4 Chat tools

Three new tools registered in `@procur/catalog`:

**`lookup_apollo_org`** — given an entity slug or domain, return the cached Apollo snapshot. Tool description teaches: surface funding-stage and headcount-trend before answering "is this counterparty a viable buyer/supplier" questions; flag stale cache (`apollo_synced_at` >30 days) as a freshness limitation.

**`discover_orgs_by_criteria`** — wraps `searchOrgs`. Operator says "find me Caribbean fuel distributors with 50-500 employees that raised in the last 12 months" → tool builds the filter object, calls Apollo, returns the thin org shape. Tool description teaches: prefer this over hand-curated rolodex when the operator's criteria don't match what's already curated; the results are candidates, not vetted entries.

**`find_recent_funding_events`** — narrower convenience wrapper around `searchOrgs` with `latest_funding_date_range[min]` set to 90 days ago. Used by "who has fresh capital in [region]?" workflows. Tool description teaches: cross-check returned orgs against the rolodex; surface known overlaps and new prospects separately.

System prompt addition: a brief "Apollo data discipline" section telling the assistant that Apollo is enrichment, not source of truth; analyst notes on `known_entities` always supersede; flag staleness; never claim Apollo data as ground truth for ministries / state-owned entities (the integration silently misses those).

---

## 7. Operational sequencing

**Day 1** — Schema + service skeleton
- Migration adding `primary_domain` + Apollo cache columns to both entity tables
- `apollo_saved_searches` and `apollo_credit_log` tables
- `@procur/apollo` package skeleton with typed result shapes (no API calls yet)
- Feature flag, env var loading, credit-log helper

**Day 2** — API integration
- `enrichOrgFromApollo`, `enrichOrgsBatch`, `searchOrgs` against the live Apollo API
- Rate limiter + retry/backoff
- Test against a curated 10-entity sample

**Day 3** — Cron + saved-search runner
- Batch-enrichment cron in `services/ai-pipeline`
- Saved-search runner job
- Manual run against the Caribbean-fuel-buyer rolodex; verify match rate + credit burn

**Day 4** — Surfaces
- Entity profile "Corporate context" section + refresh button
- Rolodex funding-stage chip + sort/filter
- `/alerts` rendering for `apollo-saved-search-hit` events

**Day 5** — Chat tools + discipline
- Three new chat tools
- System prompt addition
- End-to-end test: "find me Caribbean fuel distributors that raised in last 12 months" via chat → returns candidates with funding context → operator picks one → opens entity profile → sees full snapshot

Total: 3–5 days end-to-end. Days 4 and 5 can swap or run in parallel.

---

## 8. Cost and rate-limit accounting

The `apollo_credit_log` table makes monthly burn visible. Approximate ceiling for procur's expected use:

- **Batch cron:** 1 call per 1,000 domains, weekly refresh. Caribbean rolodex ~73 entities + Venezuela/Mediterranean coverage probably tops out at <2,000 entities for the next 12 months. → ~2 calls/week → ~10 calls/month.
- **On-demand single-get:** triggered when entity profile is opened and cache is >30 days. Cap at 1 call per entity per month even if opened repeatedly (the freshness window enforces this). For a power-user opening 50 unique entities per month → ~50 calls/month.
- **Saved searches:** 1 call per saved search per run. If we expect ~10 saved searches running daily, that's ~300 calls/month.
- **Discovery from chat:** unbounded by the operator. Soft cap: log warning when a single tenant exceeds 100 discovery calls per day.

Total expected: **~400–500 Apollo API calls/month** for the Caribbean rolodex use case. Apollo's per-call credit cost depends on the plan; the credit log makes this measurable so we can tune. The 600-calls/hr endpoint limit is well above any single-tenant peak.

---

## 9. What this brief deliberately doesn't include

- **Data deduplication across Apollo + curated rolodex.** Domain match is the join key. When Apollo claims a different name than our curated row for the same domain, our row wins on display and Apollo's name lives in the snapshot. No merging.
- **Two-way sync.** Procur reads from Apollo only. We never push data back.
- **Currency normalization for revenue / funding figures.** Apollo returns USD throughout; the existing `total_value_usd` column convention applies. No FX work needed.
- **Tagging procur entities to Apollo industry taxonomies.** Our `categories` array stays authoritative; Apollo's `industry` lives in the snapshot for reference.
- **Email finder / contact-find features of Apollo.** Person enrichment is a separate brief — see §2.2.
- **Real-time enrichment on every page render.** All Apollo lookups go through the cache. Cache staleness is rendered explicitly so operators know when they're looking at a 14-day-old snapshot.

---

## 10. Success metrics

Post-deploy, after 30 days:

- **Match rate.** Of the rolodex entities that have a `primary_domain`, what % matched to an Apollo org? Target: >70% for Caribbean fuel buyers, >85% for Mediterranean refiners (Apollo's coverage skews to large companies in indexed regions).
- **Credit burn.** Actual Apollo credits consumed vs the §8 estimate. If it's >2× the estimate, tighten freshness windows and discovery-call caps.
- **Operator surfacing rate.** How often does an entity profile show "Apollo: not matched"? If it's >40% on a watched entity, the rolodex curation needs more domain capture.
- **Saved-search alert volume.** Per saved search per week. If alert volume is high but click-through is low, the search filters are too loose.

After 90 days:

- **Funding-driven outreach correlation.** Of supplier outreach that started after a recent Apollo funding-event signal, what % converted to a counsel-validated approval? This is the question that justifies whether discovery alerts are worth Apollo's per-call cost.

---

## Open decisions before build

1. **Freshness window for batch-enrichment.** Default 7 days; happy to tighten or loosen based on operator feedback.
2. **Single-get on-demand cache window.** Default 30 days; same.
3. **Per-tenant Apollo credentials, eventually?** Out of scope for v1, but the schema (`company_id` on saved-searches and the credit log) is structured so a future migration can add per-tenant master keys without reshaping data.
4. **Apollo as a fallback for unenriched entities only, or systematic enrichment?** Brief assumes systematic batch coverage. If the credit math comes back too expensive, fall back to "enrich on first profile open" only.
