# Apollo.io Integration — Org Enrichment, Discovery, People, and Hiring/Funding Signals

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-05
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/data-graph-connections-brief.md` (the existing-data joins this brief layers external enrichment onto), `docs/intelligence-layers-brief.md` (the broader signal-source taxonomy this slots into), `docs/supplier-graph-brief.md` (the rolodex/external-suppliers schema this enriches), `docs/strategic-vision.md`

This brief specifies how Apollo.io's organization and people APIs get wired into procur to (a) enrich existing rolodex entities with funding / headcount / revenue, (b) batch-seed new entities from criteria-driven searches, (c) surface hiring/funding signals as alert-able events, and (d) discover and enrich decision-maker contacts at counterparty companies. Apollo is treated as one external signal source among several — it does not become a system of record, and its data does not silently shadow the curated rolodex layer.

The work is bounded: 1 migration adding domain + Apollo cache columns to entity tables and Apollo person fields to the existing contact-enrichments table, 1 service package, 1 nightly cron, several chat tools, and a handful of UI surfaces that read the cached snapshots. Estimated effort: **4–6 days** end-to-end (org enrichment + people enrichment + UI).

---

## 1. Why this brief exists

Procur's rolodex (`known_entities`) and scraped-supplier layer (`external_suppliers`) capture **what an analyst knows** and **what public portals have published**, respectively. Neither captures the **commercial/financial context** of the entity, nor **who to actually call** at the entity:

- How big is the company in headcount, today and 24 months ago?
- What's its revenue band? Has it raised recently? At what stage?
- What technology stack does it run? (Useful proxy for sophistication and integration cost.)
- Is it hiring sales / commercial roles right now? (Signal of go-to-market expansion.)
- Have any of *our watched suppliers* raised in the last 30 days? (Signal of capital-driven aggression.)
- Who is the procurement director / commercial head / fuel-buying authority at this counterparty? Where do we send the LOI?

Today, an operator answers these questions by leaving procur, opening a browser, searching, and copy-pasting findings into deal notes. Apollo's API exposes all of the above behind four endpoints:

- `GET /organizations/{id}` — single-org full enrichment (master-key, paid)
- `POST /mixed_companies/search` — criteria-driven discovery + 1,000-domain batch enrichment (paid, 600/hr)
- `POST /mixed_people/api_search` — people search (master-key, **free** — no credits consumed; 600/hr; obfuscates last name + omits email/phone)
- `POST /people/match` (and `/people/bulk_match`) — people enrichment (paid; resolves to email + direct phone + full name)

Wiring all four into procur eliminates the browser detour and makes the data queryable, alert-able, and visible at the surfaces where deal decisions actually get made: entity profiles, the rolodex, `/alerts`, and a new "Decision-makers" panel on each entity.

Four operational gaps this closes:

**(a) Trade-finance risk read.** A supplier that just closed Series D is a different counterparty from one that hasn't raised in 3 years. Procur today cannot show that distinction. With funding fields cached on the entity, the entity profile leads with the relevant signal.

**(b) Rolodex seeding is hand-curation only.** The 73 Caribbean fuel buyers were hand-typed. The `q_organization_keyword_tags` + `organization_locations` filters in the search endpoint return that candidate set in one API call. Hand-curation stays in the loop for editorial judgment, but it stops being the bottleneck for *coverage*.

**(c) Hiring and funding signals don't flow into `/alerts`.** When a watched competitor raises a Series C or starts hiring a Caribbean trading desk, that's an event the operator wants pinged — same alert lane as award notices and KYC expirations. Apollo's filter parameters (`latest_funding_date_range`, `q_organization_job_titles`, `organization_job_locations`) make those signals queryable on a schedule.

**(d) "Who do we call?" is unanswered for most counterparties.** Procur's `entity_contact_enrichments` table exists but is sparsely populated — vex's enrichment agent has covered some, manual entry has covered others. Apollo's people endpoints close that gap with structured title/seniority/location filters, and the search endpoint is **free**, which inverts the cost calculus: discovery is unbounded, enrichment is selective. Two specific use cases:
- *Decision-maker discovery on a known supplier.* "Find the procurement director at Petrojam" → people search filtered by `organization_ids` + `person_seniorities=director` + `person_titles=procurement` returns candidates with obfuscated names; operator picks one; enrichment resolves email/phone.
- *Outbound prospecting at an entity class.* "Find commercial heads at Caribbean fuel buyers with >500 employees" → people search filtered by `q_organization_keyword_tags` + `person_seniorities=head,vp,c_suite` + region; results enrich on demand.

---

## 2. Scope and non-scope

### 2.1 In scope

**Org-side:**
- Domain field added to `known_entities` and `external_suppliers` (precondition for any external enrichment, not Apollo-specific)
- Apollo cache columns + jsonb snapshot on both entity tables
- Nightly batch-enrichment cron that pulls funding/headcount/revenue snapshots for the rolodex via the 1,000-domains-per-call search endpoint
- On-demand single-org enrichment via `GET /organizations/{id}`, gated by the master API key, used when an operator opens an entity profile and the cache is older than the freshness threshold
- Three org chat tools: `lookup_apollo_org`, `discover_orgs_by_criteria`, `find_recent_funding_events`
- Integration surfaces: entity profile shows funding + headcount-trend; rolodex shows funding-stage chip; `/alerts` surfaces saved-search hits

**People-side:**
- `apollo_person_id` + `seniority` + `apollo_last_refreshed_at` columns added to the existing `entity_contact_enrichments` table; new `source = 'apollo'` value alongside the existing `source = 'vex'`
- People search via `POST /mixed_people/api_search` (free) — used freely from chat and entity profile
- People enrichment via `POST /people/match` (or `/people/bulk_match` for batches) — used selectively, gated by per-tenant per-day cap and operator-confirmed bulk operations
- Two people chat tools: `find_decision_makers_at_entity`, `discover_people_by_criteria`
- Entity profile gets a "Decision-makers" panel: lists Apollo-discovered people for the entity, shows obfuscated names + title + seniority + email-availability flag from search results, and an "Enrich" button that resolves email/phone (paid)
- Apollo people data writes through the existing `entity_contact_enrichments` table — same dedup discipline, same suggestion-not-overwrite rule

**Shared:**
- A `@procur/apollo` service package wrapping all four endpoints with credit-aware rate limiting, response caching, and typed result shapes
- Migration is forward-only; existing rows have `apollo_org_id = NULL` / `apollo_person_id = NULL` and get backfilled lazily

### 2.2 Out of scope

- **Intent signals.** Apollo's `intent_signal_account` block tracks B2B SaaS website visits. Useless for commodity counterparties (a Bahraini refinery is not visiting `tableofdiscontents.com`). Skipped on purpose, not deferred.
- **Apollo as a source of record.** The rolodex and external_suppliers tables remain authoritative for identity, role, categories, and analyst notes. Apollo populates a *snapshot* / suggestion sidecar; never the primary record.
- **Backfilling all 5,982 awards' awardees.** Apollo enrichment runs against rolodex entities first. Award-side enrichment is a separate decision once the rolodex case is proven.
- **Counterparty matching for non-corporate entities.** Apollo won't have ministries, state-owned authorities, refineries that lack a `.com` domain, or freight brokers that operate via personal phones. The integration silently degrades for these — `apollo_org_id IS NULL` and the UI surfaces "Apollo: not matched" without erroring.
- **Multi-tenant Apollo accounts.** v1 uses a single Apollo master key for all of procur. Per-tenant Apollo credentials are out of scope.
- **Apollo email outreach / sequence automation.** Apollo's outreach features are not in scope; procur surfaces enriched contacts but does not send mail through Apollo. Outbound stays in vex.
- **Replacing vex contact enrichments.** Apollo and vex both write to `entity_contact_enrichments` with their own `source` values. They co-exist; no migration of vex rows to Apollo or vice versa.

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

### 3.3 `POST /mixed_people/api_search` — people search (free)

**Cost:** does NOT consume credits. This inverts the cost calculus for people work — discovery is unbounded, enrichment is selective.
**Requires:** master API key. 403 without it.
**Rate limit:** 600 calls/hr (separate from the org endpoints' bucket).
**Display limit:** 50,000 records max per query (100/page × 500 pages).

What the response gives us per person:
- `id` — Apollo person ID, used to enrich later
- `first_name` (full) + `last_name_obfuscated` (e.g. "Hu***n" — first 2 + last 1, middle as `*`s)
- `title` — current job title (nullable)
- `last_refreshed_at` — Apollo's data freshness timestamp
- Boolean flags: `has_email`, `has_city`, `has_state`, `has_country`, `has_direct_phone` (`Yes` / `Maybe: please request direct dial via people/bulk_match`)
- `organization` block with `name` and capability flags (whether Apollo has industry / phone / city / state / country / zip / revenue / employee_count for the org)

Filters procur uses:
- `organization_ids[]` — scope a search to "the procurement department at THIS counterparty"
- `q_organization_domains_list[]` — same, when we have domain but not Apollo org ID
- `person_titles[]` + `include_similar_titles` — title matching
- `person_seniorities[]` — `owner` / `founder` / `c_suite` / `partner` / `vp` / `head` / `director` / `manager` / `senior` / `entry` / `intern`. The `c_suite` / `vp` / `head` / `director` set is what most procur workflows want.
- `person_locations[]` — person residence
- `organization_locations[]` — employer HQ
- `organization_num_employees_ranges[]` — gates by employer size
- `revenue_range[min/max]` — gates by employer revenue
- `contact_email_status[]` — `verified` / `unverified` / `likely to engage` / `unavailable`
- Hiring-side filters mirror the org search

**Critical limitation:** the endpoint does NOT return email addresses or phone numbers. The obfuscated last name + capability flags are enough for "is there a person here matching my filters, and does Apollo have contact data for them?" but actual email/phone resolution requires the enrichment endpoints below.

### 3.4 `POST /people/match` and `/people/bulk_match` — people enrichment (paid)

**Cost:** consumes credits per person resolved.
**Returns:** full last name, verified email + email status, direct phone (when available), LinkedIn URL, present employer details. The "Maybe: please request direct dial" hint from search resolves through this endpoint.

Two flows:
- **Single-match.** When the operator picks a person from a "Decision-makers" panel and clicks "Enrich", procur calls `/people/match` for that person ID and writes the resolved record into `entity_contact_enrichments`.
- **Bulk-match.** When the operator runs an outbound prospecting search and confirms "enrich the top 25 results" (with explicit cost confirmation), procur calls `/people/bulk_match` once for all 25 person IDs.

Discipline: enrichment is **never automatic**. Search returns the candidate set freely; resolving credits-consuming contact details requires an explicit operator action or, for cron-driven flows, a per-tenant per-day cap that prevents runaway costs.

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

### 4.4 People-side schema — extending `entity_contact_enrichments`

The existing `entity_contact_enrichments` table (migration 0052) was designed source-agnostic — the `source` column is the discriminator. Apollo plugs in as `source = 'apollo'`, alongside the existing `source = 'vex'`. The dedup key `(entitySlug, source, contactNameNormalized)` already prevents duplicate Apollo entries, and the suggestion-not-overwrite rule already protects the primary contact-of-record.

What's missing for Apollo specifically:

```sql
ALTER TABLE entity_contact_enrichments
  ADD COLUMN IF NOT EXISTS apollo_person_id text,
  ADD COLUMN IF NOT EXISTS seniority text,
  ADD COLUMN IF NOT EXISTS apollo_last_refreshed_at timestamp;

CREATE INDEX IF NOT EXISTS entity_contact_enrichments_apollo_person_id_idx
  ON entity_contact_enrichments (apollo_person_id)
  WHERE apollo_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entity_contact_enrichments_seniority_idx
  ON entity_contact_enrichments (seniority)
  WHERE seniority IS NOT NULL;
```

- `apollo_person_id` — needed for re-enrichment over time. Required when `source = 'apollo'`; nullable for legacy `source = 'vex'` rows.
- `seniority` — Apollo's structured field (`owner` / `founder` / `c_suite` / `partner` / `vp` / `head` / `director` / `manager` / `senior` / `entry` / `intern`). Filterable in the UI to surface decision-makers.
- `apollo_last_refreshed_at` — Apollo's data freshness timestamp, distinct from `enriched_at` (procur's last write).

The wider Apollo person record (LinkedIn employment history, departments, etc.) is **not** persisted as a separate jsonb column initially — the existing fields cover what procur surfaces; if we need richer person data later, add `apollo_person_snapshot jsonb` then. Avoid premature wide-column-ism.

**Pre-enrichment rows.** When people search returns a candidate, procur stores it as a row with:
- `contact_name` = `first_name + " " + last_name_obfuscated` (so the operator sees the obfuscated form)
- `email = NULL`, `phone = NULL`, `linkedin_url = NULL`
- `apollo_person_id`, `title`, `seniority`, `apollo_last_refreshed_at` populated
- `source = 'apollo'`

When the operator clicks "Enrich", procur calls `/people/match`, fills in email/phone/LinkedIn + the full last name, and updates `enriched_at`. Pre-enrichment rows are visible in the "Decision-makers" panel with an explicit "Not enriched yet" indicator + "Enrich" button.

---

## 5. Service layer architecture

A new `@procur/apollo` package, parallel to `@procur/catalog`. Six exported entry points — three org-side, three people-side:

```typescript
// packages/apollo/src/index.ts

// ─── Org-side ──────────────────────────────────────────────────

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

// ─── People-side ───────────────────────────────────────────────

/** People search via POST /mixed_people/api_search. Free — no credits.
 *  Returns obfuscated last names + email-availability flags. Persists
 *  pre-enrichment rows into entity_contact_enrichments when
 *  `entitySlug` is supplied so the search appears in the
 *  Decision-makers panel even before enrichment. */
export async function searchPeople(args: {
  filters: ApolloPeopleSearchFilters;
  /** When supplied, persists matched people as pre-enrichment rows
   *  in entity_contact_enrichments so the Decision-makers panel
   *  reflects the search. */
  entitySlug?: string;
  opts?: { page?: number; perPage?: number };
}): Promise<ApolloPeopleSearchResult>;

/** Resolves email + direct phone + full name for a single person via
 *  POST /people/match. Paid — enforces per-tenant per-day cap.
 *  Updates the matching entity_contact_enrichments row in place. */
export async function enrichPerson(args: {
  apolloPersonId: string;
  entitySlug: string;
  companyId: string;  // for the per-tenant per-day cap
}): Promise<ApolloPersonEnrichmentResult | ApolloDegradeResult>;

/** Batch person enrichment via POST /people/bulk_match. Operator-
 *  confirmed — caller must pass `confirmedCount` to acknowledge the
 *  credit cost. Used for "enrich the top 25 search results" flows. */
export async function enrichPeopleBulk(args: {
  apolloPersonIds: string[];
  entitySlug: string;
  companyId: string;
  /** Must equal apolloPersonIds.length. Defensive check that the
   *  caller has shown the operator the count + cost before calling. */
  confirmedCount: number;
}): Promise<{
  enriched: number;
  failed: { apolloPersonId: string; reason: ApolloDegradeReason }[];
  creditsSpent: number;
}>;
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

### 6.4 Decision-makers panel on entity profile

A new section between "Corporate context" and "Recent activity" — only visible when `apollo_org_id IS NOT NULL` (or after the operator has run a person search keyed to this entity):

```
Decision-makers (Apollo)                            [ + Find people ]
─────────────────────────────────────────────────────────────────────
Andrew Hu***n      Director of Procurement       [ Enrich ]
                   Email: available · Direct: maybe

Linda Ch***n       Sales Manager                  Linda.chen@example…
                   Enriched 2025-10-14            +1 (876) 555-0123
                                                  [ Promote to primary ]
```

Each row sources from `entity_contact_enrichments WHERE entity_slug = ? AND source = 'apollo'`. Rows in the pre-enrichment state (no email/phone, just the obfuscated name + title + has_email/has_direct_phone flags) get an "Enrich" button that calls `enrichPerson`. Enriched rows surface the email/phone and a "Promote to primary" CTA that lifts the contact onto the canonical contact-of-record per the existing entity_contact_enrichments suggestion-not-overwrite discipline.

The "+ Find people" button opens an inline search form with title / seniority / location filters, calls `searchPeople({ entitySlug, filters })`, and persists the candidates as pre-enrichment rows. Search is free, so this is unbounded — operators can iterate freely until the right candidates appear.

For entity profiles where Apollo has no org match, the panel is hidden entirely (no "find people" CTA without an `organization_id` to scope the search to — surface "Apollo: no match" in the Corporate context section instead).

### 6.5 Chat tools

Five new tools registered in `@procur/catalog` — three org-side and two people-side:

**Org-side:**

**`lookup_apollo_org`** — given an entity slug or domain, return the cached Apollo snapshot. Tool description teaches: surface funding-stage and headcount-trend before answering "is this counterparty a viable buyer/supplier" questions; flag stale cache (`apollo_synced_at` >30 days) as a freshness limitation.

**`discover_orgs_by_criteria`** — wraps `searchOrgs`. Operator says "find me Caribbean fuel distributors with 50-500 employees that raised in the last 12 months" → tool builds the filter object, calls Apollo, returns the thin org shape. Tool description teaches: prefer this over hand-curated rolodex when the operator's criteria don't match what's already curated; the results are candidates, not vetted entries.

**`find_recent_funding_events`** — narrower convenience wrapper around `searchOrgs` with `latest_funding_date_range[min]` set to 90 days ago. Used by "who has fresh capital in [region]?" workflows. Tool description teaches: cross-check returned orgs against the rolodex; surface known overlaps and new prospects separately.

**People-side:**

**`find_decision_makers_at_entity`** — operator says "who's the procurement director at Petrojam?" → tool resolves entity slug → `apollo_org_id` → calls `searchPeople` with `organization_ids = [apollo_org_id]` + title/seniority filters. Returns obfuscated names + titles + email-availability flags. Tool description teaches: results are candidates from a free search; do NOT call enrichment without operator confirmation; surface the most senior matching candidate first.

**`discover_people_by_criteria`** — broader people search. "Find commercial heads at Caribbean refined-product distributors with >500 employees" → builds combined org+person filters → returns candidate list grouped by employer. Tool description teaches: cap default page size at 25 to avoid an N×credits temptation; for outbound prospecting, surface the obfuscated results and let the operator manually trigger enrichment per row.

**Enrichment is not a chat tool.** The `enrichPerson` / `enrichPeopleBulk` calls only happen from the UI (entity profile panel) or from confirmed-cost operator actions in `/settings`. Keeping it out of the assistant's tool surface prevents accidental credit burn from a chat interaction.

System prompt addition: an "Apollo data discipline" section telling the assistant that (a) Apollo is enrichment, not source of truth; analyst notes on `known_entities` and primary contacts on `entity_contact_enrichments` always supersede; (b) flag staleness; (c) never claim Apollo data as ground truth for ministries / state-owned entities (the integration silently misses those); (d) **never trigger people enrichment automatically** — surface candidates from free search, let the operator promote them.

---

## 7. Operational sequencing

**Day 1** — Schema + service skeleton (✓ shipped — PR #393)
- Migration 0065 adding `primary_domain` + Apollo cache columns to both entity tables
- `apollo_saved_searches` and `apollo_credit_log` tables
- `@procur/apollo` package skeleton with typed org-side result shapes (no API calls yet)
- Feature flag, env var loading, credit-log helper

**Day 1.5** — People-side schema + types
- Migration adding `apollo_person_id`, `seniority`, `apollo_last_refreshed_at` to `entity_contact_enrichments`
- People-side types in `@procur/apollo`: `ApolloPersonThin`, `ApolloPersonFull`, `ApolloPeopleSearchFilters`, `ApolloPersonEnrichmentResult`

**Day 2** — Org API integration
- `enrichOrgFromApollo`, `enrichOrgsBatch`, `searchOrgs` against the live Apollo API
- Rate limiter + retry/backoff
- Test against a curated 10-entity sample

**Day 3** — People API integration
- `searchPeople`, `enrichPerson`, `enrichPeopleBulk` against the live Apollo API
- Per-tenant per-day enrichment cap enforced in `enrichPerson` / `enrichPeopleBulk`
- Pre-enrichment row writeback discipline in `entity_contact_enrichments`
- Test: search procurement directors at Petrojam → enrich one → row reflects email + phone + full last name

**Day 4** — Cron + saved-search runner
- Batch-enrichment cron in `services/ai-pipeline`
- Saved-search runner job (org-side initially; people-side saved searches deferred to a later iteration)
- Manual run against the Caribbean-fuel-buyer rolodex; verify match rate + credit burn

**Day 5** — Surfaces
- Entity profile "Corporate context" section + refresh button
- Entity profile "Decision-makers" panel + inline person-search form + Enrich button
- Rolodex funding-stage chip + sort/filter
- `/alerts` rendering for `apollo-saved-search-hit` events

**Day 6** — Chat tools + discipline
- Five new chat tools (three org, two people)
- System prompt addition (org enrichment discipline + people enrichment guardrail)
- End-to-end test: "find Caribbean fuel distributors that raised in last 12 months → who's the procurement director? → enrich" via chat + UI

Total: 4–6 days end-to-end. Day 1 already shipped via #393; remaining work is 4–5 days. Days 5 and 6 can swap or run in parallel.

---

## 8. Cost and rate-limit accounting

The `apollo_credit_log` table makes monthly burn visible. Approximate ceiling for procur's expected use:

**Org-side (paid):**
- **Batch cron:** 1 call per 1,000 domains, weekly refresh. Caribbean rolodex ~73 entities + Venezuela/Mediterranean coverage probably tops out at <2,000 entities for the next 12 months. → ~2 calls/week → ~10 calls/month.
- **On-demand single-get:** triggered when entity profile is opened and cache is >30 days. Cap at 1 call per entity per month even if opened repeatedly (the freshness window enforces this). For a power-user opening 50 unique entities per month → ~50 calls/month.
- **Saved searches:** 1 call per saved search per run. If we expect ~10 saved searches running daily, that's ~300 calls/month.
- **Discovery from chat:** unbounded by the operator. Soft cap: log warning when a single tenant exceeds 100 discovery calls per day.

**People-side:**
- **People search (free):** call as much as needed for discovery. The 600/hr rate limit on the search endpoint is the only ceiling. Logged in `apollo_credit_log` with `credits_spent = 0` so volume is still measurable.
- **People enrichment (paid):** the variable. Worst-case napkin math: a power user enriches 50 contacts/month at the assumed Apollo per-person cost. Hard cap at **per-tenant per-day enrichment of 25**, settable upward in admin if a deal-prep day blows through it. Bulk-enrich operations require explicit operator confirmation that names the count.

Total expected: **~400–500 paid Apollo API calls/month** for the Caribbean use case (org enrichment + selective people enrichment). Free people-search volume is uncapped. Apollo's per-call credit cost depends on the plan; the credit log makes this measurable so we can tune. The 600-calls/hr per-endpoint limits are well above any single-tenant peak.

---

## 9. What this brief deliberately doesn't include

- **Data deduplication across Apollo + curated rolodex.** Domain match is the join key. When Apollo claims a different name than our curated row for the same domain, our row wins on display and Apollo's name lives in the snapshot. No merging.
- **Two-way sync.** Procur reads from Apollo only. We never push data back.
- **Currency normalization for revenue / funding figures.** Apollo returns USD throughout; the existing `total_value_usd` column convention applies. No FX work needed.
- **Tagging procur entities to Apollo industry taxonomies.** Our `categories` array stays authoritative; Apollo's `industry` lives in the snapshot for reference.
- **Real-time enrichment on every page render.** All Apollo lookups go through the cache. Cache staleness is rendered explicitly so operators know when they're looking at a 14-day-old snapshot.
- **Apollo email outreach / sequence automation.** Outbound stays in vex; procur surfaces enriched contacts but does not send mail through Apollo.
- **Migrating vex contact rows to Apollo or vice versa.** Both sources co-exist in `entity_contact_enrichments` via the `source` discriminator. The promote-to-primary flow already in place handles which sidecar gets lifted to canonical.
- **Person-level employment history.** Apollo returns previous-employer data; procur stores only the current employer + title + seniority. Employment history is rarely the question; if it ever becomes the question, add `apollo_person_snapshot jsonb` then.

---

## 10. Success metrics

Post-deploy, after 30 days:

- **Org match rate.** Of the rolodex entities that have a `primary_domain`, what % matched to an Apollo org? Target: >70% for Caribbean fuel buyers, >85% for Mediterranean refiners (Apollo's coverage skews to large companies in indexed regions).
- **Person-coverage rate.** Of the rolodex entities that DO have an Apollo org match, what % have at least one Apollo-sourced person row in `entity_contact_enrichments`? Target: >50% within 60 days of operator activity (reflects how often the Decision-makers panel actually surfaces useful contacts).
- **Credit burn.** Actual Apollo credits consumed vs the §8 estimate. If it's >2× the estimate, tighten freshness windows, discovery-call caps, or the per-tenant per-day people enrichment cap.
- **Enrichment conversion.** Of all Apollo person rows that procur stores in pre-enrichment state, what % does the operator actually click "Enrich" on? Low conversion (<20%) signals search filters are too loose.
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
5. **Per-tenant per-day people enrichment cap.** Default 25 enrichments/day. Settable upward in admin per tenant. Worth confirming the default before Day 3.
6. **People-side saved searches?** Org-side saved searches are in scope for Day 4. People-side saved searches ("alert me when a new commercial head joins a Caribbean fuel buyer") would use the same `apollo_saved_searches` table with a `target = 'people'` discriminator. Defer to a later iteration unless the people-side use case is material from the start.
