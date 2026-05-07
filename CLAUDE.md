# CLAUDE.md

Context for AI sessions working on procur_dashboard. Read at the
start of any session, especially before touching the chat assistant
or supplier tracking surfaces.

## Repo orientation

Turborepo monorepo. Key surfaces, in rough priority order:

- `apps/app/` — `app.procur.app` (the authenticated product). Most
  user-facing changes land here. Next.js 15 App Router + Tailwind v4.
- `packages/catalog/` — public-catalog query layer + AI tool registry
  shared by Discover and the assistant. `queries.ts`, `mutations.ts`,
  `tools.ts` are the three load-bearing files.
- `packages/ai/` — assistant system prompt + LLM abstractions.
  `system-prompt.ts` is the single source of truth for assistant
  behavior; tighten it when chat traces show recurring friction.
- `packages/db/` — Drizzle schema (one file per table) + the
  hand-rolled `migrate.ts` runner. Migrations are SQL files in
  `drizzle/`.

Other apps (discover, marketing, admin) and services
(scrapers, ai-pipeline, email-digest) — see README for the full map.

## Local commands

```sh
pnpm type-check                    # tsc across all packages (fast)
cd apps/app && pnpm exec next lint # next lint catches react/no-unescaped-entities (tsc doesn't)
pnpm build                          # full Vercel-shape build
pnpm dev                            # turbo dev (Next + services)
pnpm db:migrate                     # apply pending migrations to DATABASE_URL
```

Vercel runs `pnpm turbo build --filter=@procur/app`. **`next lint`
runs on the deploy** and uses different rules than `tsc` — always run
`pnpm exec next lint` on JSX changes before pushing, or you'll
get the "unescaped entities" build failure that bit us in #311.

## Database migration footguns

The migrate runner (`packages/db/src/migrate.ts`) splits each
`.sql` file on the literal string `--> statement-breakpoint` and
sends each chunk to Neon as a separate prepared statement. Two
gotchas, both surfaced live in #307 and #308:

1. **Neon HTTP rejects multi-command statements.** Every distinct
   SQL statement in a migration needs a `--> statement-breakpoint`
   between it and the next. Forget the breakpoint between an
   `ALTER` and a `COMMENT`, you get
   `cannot insert multiple commands into a prepared statement`.

2. **The split is naive — it doesn't understand SQL comments.**
   If the literal string `--> statement-breakpoint` appears
   anywhere in a migration's `--` commentary, the runner will
   bisect the comment and produce a syntax error. Never reference
   that exact token in a comment. Use it only between statements.

Use `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` so
re-runs after a partial failure are idempotent (Neon HTTP is
auto-commit per call; there's no transaction wrapping the file).

The journal (`drizzle/meta/_journal.json`) is for `drizzle-kit`'s
benefit — `migrate.ts` reads files directly from `drizzle/` and
filters via `__drizzle_migrations`, so journal entries aren't
required for new migrations to apply.

## Per-tenant supplier-approval / KYC system (PR #309)

`supplier_approvals` table — one row per `(company_id,
entity_slug)`. Status taxonomy:

- `pending` — outreach started, no docs
- `kyc_in_progress` — KYC submitted, supplier reviewing
- `approved_without_kyc` — contractual approval (no formal KYC)
- `approved_with_kyc` — full approval, KYC complete
- `rejected` — supplier declined
- `expired` — KYC lapsed (12-month re-cert typical)

`entity_slug` is text (not FK) — accepts both `known_entities.slug`
and `external_suppliers.id` (whatever `getEntityProfile` accepts).

Surfaces:
- **Entity profile (`/entities/[slug]`)**: `<KycBadge size="lg">`
  next to the h1 + a `<SupplierApprovalForm>` with three modes
  (legacy-tag callout / one-click CTA / full edit form).
- **Rolodex (`/suppliers/known-entities`)**: inline `<KycBadge>`
  on each row + an Approval filter chip row + `?approval=...` URL
  param.
- **Settings (`/settings`)**: "Supplier approvals" summary section.
- **Chat**: `lookup_known_entities` returns `approvalStatus` per
  entity for the calling company; assistant groups suppliers by
  transactability (approved → in flight → not engaged). New
  `set_supplier_approval` write tool flips status.

The legacy `kyc-approved` tag (free text, global on the entity) is
**distinct** from a structured approval row. Don't auto-import
across tenants. The entity profile's `<SupplierApprovalForm>`
detects the legacy tag and offers a one-click "Import as KYC
Approved" — that's the only path; never write per-tenant rows
from the global tag silently.

## Per-company trading-economics preferences (PR #304)

Four nullable columns on `companies`:
- `default_sourcing_region` (text, matches `FreightOriginRegion`)
- `target_gross_margin_pct` (numeric, decimal: 0.05 = 5%)
- `target_net_margin_per_usg` (numeric, USD/USG)
- `monthly_fixed_overhead_usd_default` (integer)

`compose_deal_economics` resolves these via `getCompanyDealDefaults`
in its tool handler and merges them as defaults into the per-call
input — per-call values still win. NULL preserves the calculator's
hard-coded default (back-compat).

Set defaults at `/settings` → "Trading economics".

## compose_deal_economics cost model (PR #303)

Cost-fallback selector lives in `sourcingRegion`:
- `usgc` (or omitted) → NYH/USGC spot benchmark
- anything else → Brent + per-product crack spread mid (mirrors
  `plausibility.ts` `CRACK_SPREAD_USD_BBL`)

Forgetting `sourcingRegion` for a Med/Mideast/India-origin cargo
overstates `productCost` by $15–25/bbl and produces false
do_not_proceed verdicts. The system prompt has a "what's our
profit?" workflow that chains `evaluate_target_price` (no-target
mode) → `compose_deal_economics` so sell-price anchors come from
real benchmarks, not a guess.

## Chat-tool friction discipline (recurring theme)

Every chat-tool change has come from a real trace where the model
failed in a specific predictable way. Patterns we've codified into
`tools.ts` and `system-prompt.ts`:

- **Country codes** — country params use the shared
  `isoAlpha2Country` schema in `tools.ts`, which normalizes free-form
  input ("Poland", "USA", "Côte d'Ivoire", "DRC") to canonical ISO-2
  via `country-codes.ts`. Earlier versions used a bare
  `/^[A-Z]{2}$/` regex; the model emitted full names anyway and burned
  a tool call per retry. Downstream consumers (SQL, freight, trade
  regions) still see uppercase 2-letter codes — the transform is
  invisible past the schema boundary.
- **Combined upfront validation** — `compose_deal_economics`
  collects every missing-required field in one error rather than
  failing one field at a time (model used to retry 3+ times).
- **`noData: true` signal** — when a query returns empty
  + all-null monthly bucket data, surface a clear flag instead of
  forcing the model to interpret 12 nulls. See
  `lookup_customs_flows`.
- **`topLevelWarning` lead rule** — `compose_deal_economics`
  emits a top-level warning string when sell < cost or scorecard
  is `do_not_proceed`. The system prompt's "Verdict-leading
  discipline" forces the model to lead its response with this,
  not bury it.
- **profileUrl rendering** — copy verbatim character-for-character
  including the leading `/`. Each row uses its own row's
  `profileUrl`. No invented slugs. (CEPSA Gibraltar got Vitol's
  URL once because the model reused the prior row's URL; #306.)
- **Approval-aware ranking** — `lookup_known_entities` returns
  `approvalStatus`; assistant must group suppliers by
  transactability and lead with approved.

When iterating on the assistant:
1. Read the user's pasted chat trace carefully — every retry loop
   or wrong filter is a tool-shape failure to fix.
2. Tighten `tools.ts` schema/description first; only escalate to
   `system-prompt.ts` when the issue isn't expressible in the tool
   contract.
3. PR commits should reference what the trace showed (helps the
   next session understand the rationale).

## Fuel-consumption signals (PR #414 + Tier A sources)

Per `docs/buyer-intelligence-v2-free-sources-brief.md`. Per-entity
annual bbl/yr ranges from external sources, with confidence + audit.

Schema: `fuel_consumption_signals` (entity_slug text, source,
signal_kind, fuel_type, volume_bbl_yr_min/max, confidence,
coverage_year, raw_data jsonb). `entity_slug` is text — accepts
both `known_entities.slug` and `external_suppliers.id`.

`buyer_consumption_estimate` view computes confidence-weighted
midpoint volume per entity over the last 36 months.

Tier A sources shipped (5 of 5 — brief Tier A complete):
- `seed-fuel-consumption-signals` — Caribbean mining hand-curated
- `derive-fuel-signals-power-gen` — joins GEM power plants × intensity
- `ingest-eu-mrv` — vessel-level fuel from EU MRV (file-arg-driven)
- `ingest-ni-43-101` — Sonnet-extracts SEDAR+ technical reports
- `ingest-bond-prospectus` — Sonnet-extracts Luxembourg/EMMA/EDGAR
- `ingest-eiti-report` — Sonnet-extracts T&T / Suriname EITI reports
- `ingest-viirs-ntl` — VIIRS DNB GeoTIFF activity proxy

PDF + LLM ingestion lives in `@procur/ai` (has `unpdf` + Anthropic
SDK + `dotenv`). DB-only ingests live in `@procur/db`.

Confidence framing: regulatory disclosure (EITI, NI 43-101, customs)
sits at 0.85+; analyst-curated mining 0.7; website-extracted
marketing data caps at 0.85 but typically 0.4-0.6.

`lookup_known_entities` + `analyze_supplier` chat tools surface
`consumptionSignals` per entity.

## ML embedding layer (PR #419 / #422-#427)

Per `docs/procur-ml-layer-brief.md`. Component A (vector store) +
B (GraphSAGE training) + D (attribute prediction + mention
resolution) shipped. C (two-tower) deferred per brief §12.2 —
gated on ≥10K match-outcome labels.

**Three distinct embedding spaces** (separate tables, never mix
similarity calcs across them):
- `entity_embeddings` (vector(128)) — graph-structural, populated
  by GraphSAGE training in `services/ml-training/` (Python project)
- `entity_text_embeddings` (vector(1536)) — English-leaning text
  similarity for mention resolution, populated by
  `seed-entity-text-embeddings` via OpenAI `text-embedding-3-small`
- `bge_text_embeddings` (vector(1024)) — multilingual (100+ lang)
  retrieval, populated by BGE-M3 (BAAI, MIT). Polymorphic owner
  shape `(owner_type, owner_id)` — covers entity / web_summary /
  message / document / loi / icpo / assay / deal_note. Migration
  0086.

`signal_embeddings` (vector(128)) for signal-side similarity.

Catalog query helpers: `findSimilarEntities`, `findSimilarSignals`,
`findEntitiesByText`, `resolveEntityMention`,
`predictEntityAttributes`, `findByBgeText`, `upsertBgeEmbedding`.
`getEntityWebIntelligenceWithOverlay` falls back to fuzzy-name
match when the supplier.id is an external_suppliers UUID without
a direct embedding (Codex P2 follow-up on #428).

Python ML pipeline lives outside pnpm/turbo at
`services/ml-training/` — own pyproject.toml + uv venv.

GraphSAGE workflow:
```sh
pnpm extract-graph --output graph.json
python -m procur_ml.train --graph graph.json   # trains + saves checkpoints/best/
python -m procur_ml.upsert --embeddings embeddings.json
# inductive (single new entity, sub-second on CPU):
pnpm extract-graph --single-entity=<slug> --output single.json
python -m procur_ml.embed_entity --graph single.json --upsert
```

BGE-M3 workflow (multilingual text embeddings):
```sh
# install the optional [bge] extra (sentence-transformers; pulls
# in transformers + huggingface-hub but not pyarrow). Either uv or
# plain pip works:
cd services/ml-training
python -m venv .venv && source .venv/bin/activate
pip install -e '.[bge]'         # zsh users: quote the brackets
cd ../..
# extract candidate texts: known_entities (name + aliases + combined)
# + entity_web_summaries (per section_kind)
pnpm extract-bge-texts --output bge-texts.json
# embed with BGE-M3 (loads BAAI/bge-m3, emits 1024-dim dense vectors)
python -m procur_ml.bge_m3 embed --input bge-texts.json --output bge-embeddings.json
# write back
pnpm upsert-bge-embeddings --input bge-embeddings.json
# query a single string (prints 1024-dim JSON to stdout)
python -m procur_ml.bge_m3 query --text "refinería de Cartagena"
```

BGE-reranker-v2-m3 (cross-encoder, post-retrieval sharpening):
- Catalog helper `rerankPassages({ query, passages, topK })` — calls
  HuggingFace Inference API when `HUGGINGFACE_API_TOKEN` is set,
  falls back to identity (input order) otherwise.
- Every call writes a row to `retrieval_runs` (audit + offline eval).
  Scores stay INTERNAL — never surface in operator-facing copy.
- Wired into `buildCommunicationContextPack(intent)` to reorder
  webSummaries by intent relevance before LLM drafting.
- Offline batch path:
  ```sh
  python -m procur_ml.bge_reranker rerank --input pairs.json --output scored.json
  python -m procur_ml.bge_reranker score --query "ULSD cargo" --passages '["…", "…"]'
  ```

## Website intelligence (PR #428)

Per chat agreed-scope thread — frames as "company intelligence
enrichment", NOT an ML feature layer. Outreach + chat dossier
lift; graph-extraction edge contributions deferred to v2.

Three tables: `entity_web_pages` (page text in Vercel Blob, hash
+ `skip_reason`), `entity_web_facts` (fact_type / value / evidence
/ confidence), `entity_web_summaries` (7 narrative section_kinds:
company_overview, products_services, operations, fuel_relevance,
crude_relevance, logistics_relevance, contact_path).

Crawler: `crawl-entity-website` in `@procur/ai`. Path: fetch
homepage → `classifyPage` whitelist (home/about/products/services/
operations/assets/investors/sustainability/contact/terminals/
refineries/fleet/projects) → robots.txt cache → 1-sec polite
delay → Vercel Blob upload (optional) → single Sonnet pass over
concatenated text. 90-day re-crawl skip unless `--refresh`.
Re-crawl gate checks `entity_web_summaries` (extracted output),
NOT `entity_web_pages` — skip rows would otherwise lock entity
out for 90 days (Codex P2 fix).

Surfaced via `analyze_supplier`'s `webIntelligence` field. UI
panel on `/entities/[slug]` (read-only; refresh button gated on
Trigger.dev v3→v4 since sync HTTP would time out).

## Feedback events (PRs #430-#435)

Per `docs/feedback-ui-brief.md`. Single `feedback_events` table for
all five patterns (kind: match_quality / entity_attribute /
friction / disposition / retrospective). JSONB payload + context;
sentiment column extracted to indexable text. Soft-delete via
`revoked_at`.

Coexists with vex's `match_outcome_events` (PR #309) — feedback
UI writes to BOTH for backward compat per brief §3.2.

Per-pattern ancillaries:
- `signal_mute_rules` (Pattern 1) — structural (user, entity,
  signal_type, source) suppression. `getMatchQueue({ userId })`
  filters via NOT EXISTS subquery.
- `friction_status` (Pattern 3) — lifecycle (logged/reviewing/
  in_progress/shipped/wontfix), 1:1 FK to feedback_events.id.
- `entity_dispositions` (Pattern 4) — append-only history; latest
  non-superseded row = current. `current_dispositions` view
  materializes per (entity, user). `setEntityDisposition`
  supersedes via WITH-CTE in one round-trip.
- `deal_retrospectives` (Pattern 5) — UNIQUE (deal_id, user_id);
  draft + completed states; `completed_at` set on first transition.

UI surfaces:
- Match queue: `MatchQueueList` wraps rows, owns focused-row +
  global keyboard handlers (j/k navigate, f favorite, d dismiss,
  m mute, p pin), 200ms color-flash, auto-advance on f/d/m. Brief
  §4.3: "auto-advance typically doubles capture rate."
- Entity profile: `<EditableAttribute>` inline edits (whitelist
  `EDITABLE_ENTITY_ATTRIBUTES`) + `<DispositionPanel>` + global
  `<FrictionButton>` (mounted in app root layout).
- `/pinned`, `/friction`, `/relationships/heat-map`,
  `/retrospectives` — list surfaces that close brief §9
  ("show the impact of feedback"). Without these, capture rate
  decays per brief discipline §13.

Brief discipline §13: Pattern 1 ships first; resist scope creep
per pattern; audit 50 events at 30 days to validate UI calibration.

## Trigger.dev v3→v4 migration (still gated)

Multiple deferred items wait on this one upstream blocker:
- Apollo nightly cron (already broken — see `services/ai-pipeline`)
- ML Component B days 8-10 (scheduled GraphSAGE retraining)
- Website intelligence "refresh" admin button on entity profile
- Friction logging LLM auto-categorization (brief §6.3)
- Deal retrospective 7-day delayed notification (brief §8.2)

Don't try to unblock these one at a time. Migrate Trigger.dev
v3→v4 in a dedicated PR; the five follow-ups slot in cleanly
afterward.

## Vex-into-Procur merge (Phase 0 locked, 2026-05-06)

Cole owns two repos that were originally designed to integrate over
HTTP: this one (intelligence + match queue + chat) and `cjkootch/vex`
(sales execution: leads, campaigns, fuel deals, agent runtime,
communications, voice). The merge folds vex's execution capabilities
into procur as one unified deployment. Vex stays as a separate repo
for code reference; the runtime disappears at the end of Phase 6.

**Source of truth:**
- `docs/vex-into-procur-merge-brief.md` — strategic frame, capability
  mapping, phase definitions
- `docs/vex-into-procur-merge-decisions.md` — Phase 0 lock-ins (voice
  IN v1, single-user scoping, fresh-start data, Tavily + Slack ported,
  phase-by-phase PRs, schema reconciliation)

**7 phases** (~7–10 weeks total including voice):
1. Schema additions (~30 new tables; ALTERs on `companies` external_keys
   + `entity_sanctions_screens` rich columns; new `contacts` table)
2. Agent runtime (ActionDescriptor + AgentRunner + ApprovalGate +
   `cost_ledger`/`agent_runs`/`approvals` — NEW pattern atop procur's
   existing `runAgentTurn` budget gate; Phase 2 introduces approvals)
3. Communications (Resend inbound webhook + inbox UI +
   EmailReplyDraftAgent)
4. Sales (leads/campaigns/follow-ups; refactor push-to-vex routes →
   qualify-as-lead in-process; delete `vex-client.ts`)
5. Deal execution (fuel deal modeling — highest-value capability vex
   brings; deal calculator + DealEvaluator + DealMarketContext agents)
6. Sanctions + signals + cutover (multi-list screening, signals layer,
   DailyBrief; vex deployment offline; delete ingest routes + env vars)
7. Voice (Twilio + voice-bridge + calls/voice UI — IN v1 per Cole)

**Disciplines:**
- Vex code that ports into procur becomes procur code in procur's
  package namespaces. NEVER create `@vex/*` namespaces.
- Vex repo is code reference, not a runtime dependency.
- Each phase is a separate PR; no long-running merge branch.
- Resist scope creep within phases; each ships bounded value.

## Fuel-consumption signals (PR #414 + Tier A sources)

Per `docs/buyer-intelligence-v2-free-sources-brief.md`. Per-entity
annual bbl/yr ranges from external sources, with confidence + audit.

Schema: `fuel_consumption_signals` (entity_slug text, source,
signal_kind, fuel_type, volume_bbl_yr_min/max, confidence,
coverage_year, raw_data jsonb). `entity_slug` is text — accepts
both `known_entities.slug` and `external_suppliers.id`.

`buyer_consumption_estimate` view computes confidence-weighted
midpoint volume per entity over the last 36 months.

Tier A sources shipped (5 of 5 — brief Tier A complete):
- `seed-fuel-consumption-signals` — Caribbean mining hand-curated
- `derive-fuel-signals-power-gen` — joins GEM power plants × intensity
- `ingest-eu-mrv` — vessel-level fuel from EU MRV (file-arg-driven)
- `ingest-ni-43-101` — Sonnet-extracts SEDAR+ technical reports
- `ingest-bond-prospectus` — Sonnet-extracts Luxembourg/EMMA/EDGAR
- `ingest-eiti-report` — Sonnet-extracts T&T / Suriname EITI reports
- `ingest-viirs-ntl` — VIIRS DNB GeoTIFF activity proxy

PDF + LLM ingestion lives in `@procur/ai` (has `unpdf` + Anthropic
SDK + `dotenv`). DB-only ingests live in `@procur/db`.

Confidence framing: regulatory disclosure (EITI, NI 43-101, customs)
sits at 0.85+; analyst-curated mining 0.7; website-extracted
marketing data caps at 0.85 but typically 0.4-0.6.

`lookup_known_entities` + `analyze_supplier` chat tools surface
`consumptionSignals` per entity.

## ML embedding layer (PR #419 / #422-#427)

Per `docs/procur-ml-layer-brief.md`. Component A (vector store) +
B (GraphSAGE training) + D (attribute prediction + mention
resolution) shipped. C (two-tower) deferred per brief §12.2 —
gated on ≥10K match-outcome labels.

**Three distinct embedding spaces** (separate tables, never mix
similarity calcs across them):
- `entity_embeddings` (vector(128)) — graph-structural, populated
  by GraphSAGE training in `services/ml-training/` (Python project)
- `entity_text_embeddings` (vector(1536)) — English-leaning text
  similarity for mention resolution, populated by
  `seed-entity-text-embeddings` via OpenAI `text-embedding-3-small`
- `bge_text_embeddings` (vector(1024)) — multilingual (100+ lang)
  retrieval, populated by BGE-M3 (BAAI, MIT). Polymorphic owner
  shape `(owner_type, owner_id)` — covers entity / web_summary /
  message / document / loi / icpo / assay / deal_note. Migration
  0086.

`signal_embeddings` (vector(128)) for signal-side similarity.

Catalog query helpers: `findSimilarEntities`, `findSimilarSignals`,
`findEntitiesByText`, `resolveEntityMention`,
`predictEntityAttributes`, `findByBgeText`, `upsertBgeEmbedding`.
`getEntityWebIntelligenceWithOverlay` falls back to fuzzy-name
match when the supplier.id is an external_suppliers UUID without
a direct embedding (Codex P2 follow-up on #428).

Python ML pipeline lives outside pnpm/turbo at
`services/ml-training/` — own pyproject.toml + uv venv.

GraphSAGE workflow:
```sh
pnpm extract-graph --output graph.json
python -m procur_ml.train --graph graph.json   # trains + saves checkpoints/best/
python -m procur_ml.upsert --embeddings embeddings.json
# inductive (single new entity, sub-second on CPU):
pnpm extract-graph --single-entity=<slug> --output single.json
python -m procur_ml.embed_entity --graph single.json --upsert
```

BGE-M3 workflow (multilingual text embeddings):
```sh
# install the optional [bge] extra (sentence-transformers; pulls
# in transformers + huggingface-hub but not pyarrow). Either uv or
# plain pip works:
cd services/ml-training
python -m venv .venv && source .venv/bin/activate
pip install -e '.[bge]'         # zsh users: quote the brackets
cd ../..
# extract candidate texts: known_entities (name + aliases + combined)
# + entity_web_summaries (per section_kind)
pnpm extract-bge-texts --output bge-texts.json
# embed with BGE-M3 (loads BAAI/bge-m3, emits 1024-dim dense vectors)
python -m procur_ml.bge_m3 embed --input bge-texts.json --output bge-embeddings.json
# write back
pnpm upsert-bge-embeddings --input bge-embeddings.json
# query a single string (prints 1024-dim JSON to stdout)
python -m procur_ml.bge_m3 query --text "refinería de Cartagena"
```

BGE-reranker-v2-m3 (cross-encoder, post-retrieval sharpening):
- Catalog helper `rerankPassages({ query, passages, topK })` — calls
  HuggingFace Inference API when `HUGGINGFACE_API_TOKEN` is set,
  falls back to identity (input order) otherwise.
- Every call writes a row to `retrieval_runs` (audit + offline eval).
  Scores stay INTERNAL — never surface in operator-facing copy.
- Wired into `buildCommunicationContextPack(intent)` to reorder
  webSummaries by intent relevance before LLM drafting.
- Offline batch path:
  ```sh
  python -m procur_ml.bge_reranker rerank --input pairs.json --output scored.json
  python -m procur_ml.bge_reranker score --query "ULSD cargo" --passages '["…", "…"]'
  ```

## Website intelligence (PR #428)

Per chat `agreed-scope` thread — frames as "company intelligence
enrichment", NOT an ML feature layer. Outreach + chat dossier
lift; graph-extraction edge contributions deferred to v2.

Three tables: `entity_web_pages` (page text in Vercel Blob, hash
+ `skip_reason`), `entity_web_facts` (fact_type / value / evidence
/ confidence), `entity_web_summaries` (7 narrative section_kinds:
company_overview, products_services, operations, fuel_relevance,
crude_relevance, logistics_relevance, contact_path).

Crawler: `crawl-entity-website` in `@procur/ai`. Path: fetch
homepage → `classifyPage` whitelist (home/about/products/services/
operations/assets/investors/sustainability/contact/terminals/
refineries/fleet/projects) → robots.txt cache → 1-sec polite
delay → Vercel Blob upload (optional) → single Sonnet pass over
concatenated text. 90-day re-crawl skip unless `--refresh`.
Re-crawl gate checks `entity_web_summaries` (extracted output),
NOT `entity_web_pages` — skip rows would otherwise lock entity
out for 90 days (Codex P2 fix).

Surfaced via `analyze_supplier`'s `webIntelligence` field. UI
panel on `/entities/[slug]` (read-only; refresh button gated on
Trigger.dev v3→v4 since sync HTTP would time out).

## Feedback events (PRs #430-#435)

Per `docs/feedback-ui-brief.md`. Single `feedback_events` table for
all five patterns (kind: match_quality / entity_attribute /
friction / disposition / retrospective). JSONB payload + context;
sentiment column extracted to indexable text. Soft-delete via
`revoked_at`.

Coexists with vex's `match_outcome_events` (PR #309) — feedback
UI writes to BOTH for backward compat per brief §3.2.

Per-pattern ancillaries:
- `signal_mute_rules` (Pattern 1) — structural (user, entity,
  signal_type, source) suppression. `getMatchQueue({ userId })`
  filters via NOT EXISTS subquery.
- `friction_status` (Pattern 3) — lifecycle (logged/reviewing/
  in_progress/shipped/wontfix), 1:1 FK to feedback_events.id.
- `entity_dispositions` (Pattern 4) — append-only history; latest
  non-superseded row = current. `current_dispositions` view
  materializes per (entity, user). `setEntityDisposition`
  supersedes via WITH-CTE in one round-trip.
- `deal_retrospectives` (Pattern 5) — UNIQUE (deal_id, user_id);
  draft + completed states; `completed_at` set on first transition.

UI surfaces:
- Match queue: `MatchQueueList` wraps rows, owns focused-row +
  global keyboard handlers (j/k navigate, f favorite, d dismiss,
  m mute, p pin), 200ms color-flash, auto-advance on f/d/m. Brief
  §4.3: "auto-advance typically doubles capture rate."
- Entity profile: `<EditableAttribute>` inline edits (whitelist
  `EDITABLE_ENTITY_ATTRIBUTES`) + `<DispositionPanel>` + global
  `<FrictionButton>` (mounted in app root layout).
- `/pinned`, `/friction`, `/relationships/heat-map`,
  `/retrospectives` — list surfaces that close brief §9
  ("show the impact of feedback"). Without these, capture rate
  decays per brief discipline §13.

Brief discipline §13: Pattern 1 ships first; resist scope creep
per pattern; audit 50 events at 30 days to validate UI calibration.

## Trigger.dev v3→v4 migration (still gated)

Multiple deferred items wait on this one upstream blocker:
- Apollo nightly cron (already broken — see `services/ai-pipeline`)
- ML Component B days 8-10 (scheduled GraphSAGE retraining)
- Website intelligence "refresh" admin button on entity profile
- Friction logging LLM auto-categorization (brief §6.3)
- Deal retrospective 7-day delayed notification (brief §8.2)

Don't try to unblock these one at a time. Migrate Trigger.dev
v3→v4 in a dedicated PR; the five follow-ups slot in cleanly
afterward.
