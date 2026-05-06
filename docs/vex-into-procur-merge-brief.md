# Vex-into-Procur Merge: Phased Execution Plan

**Status:** working brief, implementation-gated
**Owner:** Cole (procur and vex are Cole's personal IP)
**Last updated:** 2026-05-06
**Repos:** `cjkootch/procur_dashboard` (target), `cjkootch/vex` (source, kept separate)
**Implementation context:** This brief is consumed by Claude Code at the time of implementation. It specifies how to fold vex's execution capabilities into procur as one unified deployment, while keeping vex as a separate repo whose code can be reused. Third-party tools unique to vex are replaced where procur already has equivalent infrastructure.

> **Phase 0 decisions resolving §12 are in `docs/vex-into-procur-merge-decisions.md`.** That document is the binding source of truth for implementation; this brief is the strategic frame.

---

## 1. What this brief is and isn't

**It is** a phased plan for migrating vex's execution capabilities (sales pipeline, CRM, communications, fuel deals, agent runs, approvals) into procur's deployment so Cole can operate everything in one system.

**It is not** a full vex-rewrite. Vex code is reused wherever it cleanly fits procur's stack. Where vex uses third-party tools that procur doesn't (Temporal, BullMQ, NestJS+Fastify, Twilio voice, OpenFGA, next-auth), the brief specifies replacements using tools procur already has.

**It is not** a deprecation of vex the repository. Cole keeps vex as a separate repo. The migration extracts logic and ports it to procur with deliberate code reuse, not a one-time copy that orphans vex.

**It is not** a plan to bring across every vex feature. Some features (Twilio voice, multi-tenant scaffolding) are deferred or dropped because they don't fit procur's deployment model. The brief explicitly calls out what gets ported, what gets deferred, and what gets dropped.

---

## 2. Strategic context

The system Cole has built is two repos that were designed to integrate, not be unified:

- **procur** — Next.js 15 + Clerk + Drizzle/Neon + Trigger.dev v3 + Vercel Blob + Stripe + Sentry. Multi-app monorepo (`apps/admin`, `apps/app`, `apps/discover`, `apps/marketing`). 65 schema tables. Intelligence warehouse: opportunities, entities, awards, suppliers, customs, vessels, ports, embeddings, AI assistant, match queue, deal structures, fuel buyer rolodex.
- **vex** — Next.js 14 web + NestJS/Fastify API + BullMQ/Temporal worker + MCP. 41 schema tables. Execution platform: leads, campaigns, follow-ups, threads, touchpoints, agent runs, approvals, fuel deals (with cost stack, cashflow events, scenarios, counterparty scores, participants), Twilio voice calls, Resend inbound/outbound email.

Vex already has a `docs/procur-integration.md` spec describing one-way data flow (procur → vex via `ProcurClient` HTTP, with `procur_intelligence_snapshots` and `fuel_deal_market_context` schemas in vex). Three integration agents are partially shipped: `ProcurEnrichmentAgent`, `DealMarketContextAgent`, `CampaignTargetingAgent`. The integration as designed treats the two systems as separate processes communicating over HTTP.

The merge inverts this. **Instead of vex calling procur over HTTP, the vex execution capabilities run inside procur's deployment, querying procur's data directly through Drizzle.** Cole gets one URL, one auth boundary, one deploy target, and one operational surface.

Vex stays as a separate repo for two reasons:

1. Code reference and selective reuse — porting logic is faster when the source codebase remains intact and queryable
2. Optionality — if procur and vex need to diverge later (e.g., enterprise multi-tenant deployment of vex separately), the repository remains the canonical source

---

## 3. The cleanest framing

**Vex is fundamentally seven capabilities riding on top of procur-like primitives:**

1. **Communications inbox** — touchpoints + threads + messages + activities, with Resend inbound translator and reply drafting
2. **Sales pipeline** — leads + campaigns + campaign steps + campaign enrollments + follow-ups
3. **Fuel deal modeling** — fuel deals + cost stack + cashflow events + scenarios + counterparty scores + participants + market context
4. **Agent runtime** — agent runs + approvals + cost ledger + ActionDescriptor pattern + Anthropic-driven agents (DailyBrief, Research, FollowUp, CallPrep, DealEvaluator, LeadQualification, Reactivation, OFAC, VesselIntelligence, FreightMarket, PortIntelligence, EmailReplyDraft, ProcurEnrichment, ContactEnrichment)
5. **Voice** — Twilio outbound calls + voice bridge + transcript processing
6. **Hot/inbox/strategy/chat web surfaces** — `/app/hot`, `/app/inbox`, `/app/inbox/t`, `/app/calls`, `/app/voice`, `/app/strategy`, `/app/chat`, `/app/companies`, `/app/deals`, `/app/follow-ups`, `/app/marketing`, `/app/signals`
7. **Workflows** — Temporal-orchestrated long-running flows (follow-up, research, campaign enrollment, outbound call)

Procur already has equivalents or close adjacencies for several of these:

- Procur has `entities`, `companies`, `match_queue`, `match_outcome_events`, `assistant_threads`, `assistant_messages`, `documents`, `embeddings` — most of vex's contact/touchpoint/messaging primitives can map onto these with extension rather than replacement
- Procur has its own AI assistant in `packages/ai/assistant/`, agent task running in `services/ai-pipeline/`, and MCP server in `packages/mcp-server/`
- Procur uses Trigger.dev v3 for background jobs (replaces vex's Temporal+BullMQ)
- Procur uses Clerk for auth (replaces vex's next-auth + OpenFGA)
- Procur uses Vercel Blob for object storage (replaces vex's S3)

**Vex's fuel deal modeling has no procur equivalent.** This is the most material new capability that the merge brings into procur.

---

## 4. Third-party tool replacement decisions

The merge replaces vex-only third-party tools with procur's existing equivalents wherever feasible.

| Vex uses | Procur uses | Decision |
|---|---|---|
| **Temporal** (workflow orchestration) | Trigger.dev v3 | **Replace.** Express vex's 4 Temporal workflows (follow-up, research, campaign enrollment, outbound call) as Trigger.dev v3 tasks. See §5.6. |
| **BullMQ + ioredis** (queue) | Trigger.dev v3 | **Replace.** Vex's queue jobs (daily-digest, intent-classifier, follow-up-notifier, signals, enrollment-reconciliation) become Trigger.dev tasks. |
| **NestJS + Fastify** (API framework) | Next.js 15 API routes | **Replace.** Port vex's API modules (agent-runs, approvals, calls, communications, deals, follow-ups, leads, marketing, organizations, signals, strategy, voice, ingest, webhooks) to Next.js route handlers. Existing procur `apps/app/app/api/` is the target. |
| **next-auth + @auth/core + OpenFGA** | Clerk | **Replace.** Drop vex's auth stack entirely. Procur's Clerk session is the auth boundary. ApprovalTier remains as a domain concept; it doesn't require OpenFGA. |
| **AWS S3** | Vercel Blob | **Replace.** Vex's `S3Uploader` becomes a Vercel Blob uploader with the same interface. Transcript object keys, document uploads, attachment storage all route to Vercel Blob. |
| **@vex/db (Drizzle on Neon)** | @procur/db (Drizzle on Neon) | **Merge.** Both are Drizzle-on-Neon already. Vex schemas migrate into procur's schema namespace as additive tables. No structural change to ORM. |
| **@vex/ui + zod** | @procur/ui + zod | **Merge.** Both are TypeScript+zod. ViewManifest pattern from vex is useful; port selectively where procur doesn't already have equivalent component patterns. |
| **Twilio (voice + SDK)** | (none) | **Port — IN v1.** Per Phase 0 decision (`docs/vex-into-procur-merge-decisions.md` §1), voice is in scope; Phase 7 ships alongside Phases 1–6. |
| **@modelcontextprotocol/sdk (vex MCP server)** | @procur/mcp-server | **Consolidate.** Procur already has MCP server infrastructure with chatgpt-handler, rate-limiter, whitelist. Vex MCP tools merge into procur MCP surface. |
| **Anthropic + OpenAI clients** | Anthropic + OpenAI clients (in @procur/ai) | **Already shared.** No replacement needed. |
| **Resend (email)** | Resend (in procur for transactional/marketing) | **Already shared.** Procur already uses Resend. Vex's Resend usage (inbound translator, reply send) merges in directly. |
| **Apollo (people/org enrichment)** | Apollo (in procur services/ai-pipeline) | **Already shared.** Procur has more mature Apollo integration; vex's Apollo usage points to procur's. |
| **Tavily (web search)** | Tavily | **Port** (Phase 0 decision §5). Lands in Phase 4 with ResearchAgent. |
| **OpenTelemetry** | Sentry + OpenTelemetry | **Merge.** Both use OTel. Procur uses Sentry as the main APM; vex's OTel exporters route to Sentry. |
| **OFAC SDN, UK OFSI, EU consolidated, CSL sanctions lists** | (procur has `entity-sanctions-screens`) | **Port.** Vex's sanctions list integrations are the more mature path; procur's `entity-sanctions-screens` table receives the data. See §6.5. |
| **Pricing data integrations (vex)** | EIA, FRED, ECB FX, EU MRV, Comtrade in procur | **Procur is more mature.** Vex's pricing integrations consume procur's; no separate migration. |
| **email-verifier** | (none in procur) | **Port.** Useful for outbound campaign hygiene. Add to procur as a small utility module. |
| **call-window, voice-bridge** | (none, depends on Twilio) | **Port — IN v1** (Phase 7 active). |
| **Slack integration** | (none in procur) | **Port** (Phase 0 decision §6). Lands alongside Phase 6 signals/DailyBrief. |

---

## 5. Capability-by-capability migration plan

For each capability area, this section specifies what migrates, where it lands in procur, what changes, and what's intentionally dropped.

### 5.1 Communications inbox (touchpoints, threads, messages, activities)

**What vex has:**

- `touchpoints` — outbound communication units (email, SMS, call attempt)
- `threads` — conversation threads grouping related messages
- `messages` — individual inbound/outbound messages with content
- `activities` — domain events (email.sent, call.completed, lead.created, etc.)
- Resend inbound translator (`packages/integrations/src/normalizers/resend.ts`)
- Email reply draft agent (`EmailReplyDraftAgent`)
- `/app/inbox`, `/app/inbox/[id]`, `/app/inbox/t` (templates) web pages

**Migration target:**

- New procur tables: `procur.touchpoints`, `procur.threads`, `procur.messages`, `procur.activities` (additive — none conflict with procur's existing schema)
- New procur API routes under `apps/app/app/api/communications/` matching vex's NestJS module shape
- New procur web routes under `apps/app/app/inbox/`, `apps/app/app/inbox/[id]/`, `apps/app/app/inbox/t/`
- Resend inbound webhook handler at `apps/app/app/api/webhooks/resend/route.ts` calling the inbound translator
- Email reply draft becomes a Trigger.dev task `tasks/email-reply-draft` consuming the same prompts from vex's `packages/agents/src/prompts/email-reply-draft.ts`

**Drop / defer:**

- Vex's NestJS controllers and DTOs (replaced by Next.js route handlers + zod)
- WhatsApp template scaffolding from vex prompts (port if Cole needs it; defer otherwise)

**Code reuse from vex:**

- Schema files (port verbatim with namespace adjustments)
- Resend inbound translator logic (`resend-inbound-translator.ts`, `resend-verifier.ts`)
- Email reply draft prompts and parsing
- Activity event types from `packages/db/src/schema/events.ts`

### 5.2 Sales pipeline (leads, campaigns, follow-ups)

**What vex has:**

- `leads` — qualified opportunities with `procur_metadata` JSON sidecar (already designed to receive procur push)
- `campaigns` + `campaign_steps` + `campaign_enrollments` — multi-step outreach automation
- `follow-ups` — scheduled future actions on a contact/org
- `LeadQualificationAgent`, `FollowUpAgent`, `ResearchAgent`, `ReactivationBatchAgent`
- `/app/follow-ups`, `/app/marketing`, `/app/marketing/[id]` web pages
- `/ingest/procur/leads` endpoint (already accepts procur pushes — see vex `apps/api/src/ingest/`)

**Migration target:**

- New procur tables: `procur.leads`, `procur.campaigns`, `procur.campaign_steps`, `procur.campaign_enrollments`, `procur.follow_ups`
- Procur already has `match-queue/[id]/push-to-vex/route.ts` — this becomes `match-queue/[id]/qualify-as-lead/route.ts` since the push target is now internal, and the lead-creation logic runs in-process instead of HTTP
- Lead qualification, follow-up scheduling, reactivation scoring become Trigger.dev tasks
- New procur web routes under `apps/app/app/follow-ups/`, `apps/app/app/marketing/`, and a leads view (procur doesn't currently have a sales-pipeline-style leads UI distinct from match queue)

**Drop / defer:**

- Vex's tenant-scoped lead isolation logic (procur is single-user per Phase 0 §2; tenant scoping becomes user-scoping under Clerk)
- Multi-tenant campaign step enrollment reconciliation (simplifies to single-user)

**Code reuse from vex:**

- Schema definitions (`leads.ts`, `campaigns.ts`, `campaign-steps.ts`, `campaign-enrollments.ts`, `follow-ups.ts`)
- Repository implementations (`lead-repository.ts`, `campaign-repository.ts`, `campaign-step-repository.ts`, `campaign-enrollment-repository.ts`, `follow-up-repository.ts`)
- Agent implementations (`lead-qualification.ts`, `follow-up.ts`, `research.ts`, `reactivation.ts`)
- Strategy draft prompts and rendering
- ProcurMetadata interface from `leads.ts` — this is a documented contract for procur→lead handoff and is already aligned with procur's data shape

### 5.3 Fuel deal modeling (the highest-value vex capability)

**What vex has:**

- `fuel_deals` — primary deal record (counterparties, product, volumes, dates)
- `fuel_deal_cost_stack` — line-item cost breakdown
- `fuel_deal_cashflow_events` — payment timing model
- `fuel_deal_scenarios` — what-if modeling
- `fuel_deal_counterparty_scores` — 8-dimensional risk scoring
- `fuel_deal_documents` — deal-attached docs
- `fuel_deal_participants` — multiple counterparties per deal
- `fuel_deal_market_context` — procur intelligence snapshot at draft→live transition
- `fuel_market_rates`, `freight_rates` — pricing reference data
- `DealEvaluatorAgent`, `DealMarketContextAgent`
- `/app/deals`, `/app/deals/[id]` web pages
- Deal calculator logic in `packages/db/src/deals/calculator.ts`

**Migration target:**

- New procur tables (all additive): `fuel_deals`, `fuel_deal_cost_stack`, `fuel_deal_cashflow_events`, `fuel_deal_scenarios`, `fuel_deal_counterparty_scores`, `fuel_deal_documents`, `fuel_deal_participants`, `fuel_deal_market_context`, `fuel_market_rates`, `freight_rates`
- New procur API routes under `apps/app/app/api/deals/`
- New procur web routes under `apps/app/app/deals/` and `apps/app/app/deals/[id]/`
- Deal calculator ported as `packages/utils/src/deal-calculator.ts`
- DealEvaluatorAgent ported as a Trigger.dev task or assistant tool
- DealMarketContextAgent runs at deal status transition; instead of HTTP-fetching procur, queries procur tables directly

**Procur-side benefits unique to merge:**

- Deal market context now reads procur's `commodity_prices`, `customs_imports`, `vessel_positions`, `entity-news-events` directly without round-trip
- Counterparty scores now consume procur's `entity-ownership`, `entity-sanctions-screens`, `entity-activity-observations` natively
- The procur `match_queue` can now flow into a fully-modeled deal in the same system

**Drop / defer:**

- Multi-tenant scoping (becomes user-scoping per Phase 0 §2)
- Some vex deal lifecycle states that don't apply (e.g., tenant approval gates if not used)

**Code reuse from vex:**

- All fuel-deal-* schema files (port verbatim)
- `calculator.ts` with tests
- `fuel-deal-*-repository.ts` files
- DealEvaluator agent prompt and Anthropic invocation pattern
- Deal-related ActionDescriptor variants from `action.ts`

### 5.4 Agent runtime (the architectural backbone)

**What vex has:**

- `agent_runs` table tracking every agent execution with cost
- `approvals` table with discriminated-union ActionDescriptor payloads
- `cost_ledger` for per-agent cost accounting
- `AgentRunner` class orchestrating: cost gate → kill-switch check → agent execution → approval creation → activity logging → cost recording
- `ApprovalGate` for tier-based approval requirements (T0 auto, T1 internal-only, T2 needs human, T3 needs reviewer + reason)
- 14 agent implementations
- ActionDescriptor zod schema with ~30 action variants

**Migration target:**

- New procur tables: `agent_runs`, `approvals`, `cost_ledger` (additive — procur has `ai-usage` and `tool-call-logs` already, but the agent-run/approval pattern is a different abstraction layer; both can coexist)
- AgentRunner moved into procur as `packages/ai/src/agent-runner.ts` (procur already has `packages/ai/`)
- ApprovalGate moves into procur
- All 14 agent implementations port to procur, consuming procur's data through Drizzle directly instead of through the cross-system HTTP boundary
- Approval UI lives at procur `apps/app/app/approvals/` (procur doesn't currently have this surface)
- Agents that previously called ProcurClient drop the HTTP layer and call procur tables in-process

**Procur-side context (correction from initial brief framing):**

Procur's existing agent loop is `runAgentTurn()` in `packages/ai/src/assistant/loop.ts` — a functional loop with budget gating via `packages/ai/src/assistant/budget.ts`. There is no class-based AgentRunner today. Phase 2 introduces the AgentRunner + ApprovalGate pattern as a NEW architectural layer; budget gating in `runAgentTurn` continues to fire as the outermost kill-switch even when an action requires approval. `ai_usage` and `tool_call_logs` continue to coexist with the new `cost_ledger` and `agent_runs` tables.

**Procur-side benefits unique to merge:**

- Agent runs become first-class in procur's observability (Sentry traces, PostHog events)
- Cost ledger unifies with procur's existing `ai-usage` for one cost view across the system
- Approval queue becomes a meaningful procur surface (currently absent)

**Drop / defer:**

- Tenant scoping (becomes user-scoping per Phase 0 §2)
- OpenFGA authorization checks (replaced by Clerk role checks where applicable)
- Twilio-related ActionDescriptor variants — kept in scope per voice = in v1 (Phase 0 §1)

**Code reuse from vex:**

- `action.ts` (ActionDescriptor zod schema, 890 lines)
- `agent-runner.ts` (367 lines)
- `approval-gate.ts` (47 lines)
- `agents/types.ts` (AgentContext, AgentOutput, IAgent interfaces)
- All 14 agent implementation files
- Agent prompt files in `packages/agents/src/prompts/`
- Cost ledger interface from `packages/telemetry/src/cost-ledger.ts`

### 5.5 Sanctions screening

**What vex has:**

- OFAC SDN list integration (`packages/integrations/src/ofac-sdn.ts`)
- UK OFSI list integration (`uk-ofsi.ts`)
- EU consolidated list integration (`eu-consolidated.ts`)
- CSL (Consolidated Screening List) integration (`csl.ts`)
- `OFACScreeningAgent` orchestrating multi-list screening
- `ofac_screens` table

**Migration target:**

- Procur already has `entity-sanctions-screens` table — vex's `ofac_screens` schema merges with procur's by harmonizing column names
- Vex's four sanctions list integrations port to procur as `packages/sanctions/` package
- OFACScreeningAgent ports to procur, runs as Trigger.dev task or on-demand from entity profile UI
- Procur API route `apps/app/app/api/intelligence/entity/[entitySlug]/sanctions-screen/` (already exists) gets upgraded to use the new multi-list screening

**Schema reconciliation (locked in Phase 0 §6.2):** keep procur's table name `entity_sanctions_screens`; ALTER to add vex's richer columns (`list_source`, `screen_id`, `details` JSONB).

**Drop / defer:**

- Vex's tenant-scoped screening (becomes user-scoped per Phase 0 §2)

**Code reuse from vex:**

- All four list integrations (`ofac-sdn.ts`, `uk-ofsi.ts`, `eu-consolidated.ts`, `csl.ts`) including their parsing and matching logic
- `OFACScreeningAgent` and `sanctionsExposureRiskFor` helper

### 5.6 Workflows (long-running orchestration)

**What vex has:**

- 4 Temporal workflows: `follow-up-workflow.ts`, `research-workflow.ts`, `campaign-enrollment-workflow.ts`, `outbound-call-workflow.ts`
- 5 BullMQ jobs: `daily-digest-job.ts`, `intent-classifier-job.ts`, `follow-up-notifier-job.ts`, `signals-job.ts`, `enrollment-reconciliation-job.ts`
- Worker app at `apps/worker/` running Temporal worker + BullMQ workers

**Migration target:**

- All four Temporal workflows become Trigger.dev v3 tasks under `services/ai-pipeline/src/trigger/` or a new `services/execution/src/trigger/`:
  - `follow-up-workflow` → `tasks/follow-up.ts` (scheduled with `schedules.task`)
  - `research-workflow` → `tasks/research.ts` (manually triggered + retried via Trigger.dev's retry semantics)
  - `campaign-enrollment-workflow` → `tasks/campaign-enrollment.ts` (with sub-tasks per enrollment)
  - `outbound-call-workflow` → `tasks/outbound-call.ts` (Phase 7, active)
- All five BullMQ jobs become Trigger.dev scheduled tasks

**Translation considerations per workflow:**

- `follow-up-workflow` — Temporal sleep+continue pattern translates to Trigger.dev `wait.for` and child tasks. Straightforward.
- `research-workflow` — Mostly an agent invocation with retry. Direct port to a Trigger.dev task with retry config.
- `campaign-enrollment-workflow` — Temporal signals translate awkwardly to Trigger.dev. Restructure as: parent task spawns child tasks for each enrollment step, each child re-evaluates state from DB rather than relying on signal-based mid-workflow updates. This is more idiomatic for Trigger.dev and arguably simpler than the Temporal version.
- `outbound-call-workflow` — Active in Phase 7 per Phase 0 §1. Maps Twilio call lifecycle (initiated → ringing → connected → ended → transcribed → summarized) to a Trigger.dev task with state-machine logic.

**Drop / defer:**

- Temporal worker app entirely
- BullMQ + Redis dependency
- ioredis dependency

**Code reuse from vex:**

- Workflow business logic (port to Trigger.dev task structure)
- Activity implementations from `apps/worker/src/temporal/activities/` (these are mostly straight TypeScript and port cleanly)
- Job implementations from `apps/worker/src/jobs/` (port to Trigger.dev scheduled tasks)
- DLQ replay CLI from `apps/worker/src/cli/replay.ts` becomes a Trigger.dev management script

### 5.7 Web surfaces (UI)

**What vex has:** 12 main app routes under `apps/web/src/app/app/`:

- `/app/hot` — engagement-velocity ranked entities
- `/app/inbox`, `/app/inbox/[id]`, `/app/inbox/t`, `/app/inbox/t/[id]` — communication inbox
- `/app/calls`, `/app/calls/[id]`, `/app/calls/[id]/debug` — call list and detail (Phase 7)
- `/app/voice` — voice operator UI (Phase 7)
- `/app/strategy` — strategy draft and review
- `/app/chat` — chat interface to vex agents
- `/app/companies`, `/app/companies/[id]` — org list and profile
- `/app/contacts`, `/app/contacts/[id]` — contact list and profile
- `/app/deals`, `/app/deals/[id]` — fuel deal list and detail
- `/app/follow-ups` — follow-up triage
- `/app/marketing`, `/app/marketing/[id]` — campaign management
- `/app/signals` — proactive signal feed
- `/app/approvals` — approval queue

**Migration target:** Port to procur's `apps/app/app/` routes. Procur's `apps/app/` is the operator-facing app and the natural target.

Routes that map cleanly to procur additions:

- `/app/inbox/*` → new in procur
- `/app/follow-ups` → new in procur
- `/app/marketing/*` → new in procur
- `/app/deals/*` → new in procur
- `/app/approvals` → new in procur
- `/app/signals` → new in procur (procur has `alerts` and notifications; signals is a different abstraction layer)
- `/app/calls/*`, `/app/voice` → new in procur (Phase 7)

Routes that should reconcile with existing procur surfaces:

- `/app/hot` → integrate into procur's match queue or as a separate engagement-ranked view
- `/app/companies` → procur has `entities/[slug]` already; reconcile vex's organization-detail view into procur's entity profile
- `/app/contacts` → integrate into procur's entity profile (procur has `entity-contact-enrichments`); a separate contacts list view may not be needed
- `/app/strategy` → procur has its own assistant; reconcile with procur's existing assistant UI rather than porting vex's separate strategy surface
- `/app/chat` → procur already has chat at `apps/app/app/assistant/`; do not port vex chat as a separate UI

**Code reuse from vex:**

- Page implementations (Next.js 14 → 15 has minor differences but most server components port directly)
- Component library from `packages/ui` (zod-validated ViewManifest pattern is useful as reference; selective port where procur lacks equivalent)
- Pinned panels, manifest renderer utilities

**Anti-pattern to avoid during port:** wholesale copy of vex's component library into procur. Procur has shadcn/ui already; vex's UI components should be evaluated component-by-component for whether they replace or complement what procur has. Most should complement; do not pollute procur's component tree.

### 5.8 MCP server consolidation

**What vex has:**

- `apps/mcp/` — MCP server exposing vex tools (search contacts, search deals, search organizations, etc.)
- Token-based authentication via `mint-token.ts`

**Migration target:**

- Procur already has `packages/mcp-server/` with `chatgpt-handler`, `rate-limiter`, `whitelist`, full handler infrastructure
- Vex's MCP tools become tool registrations in procur's MCP server
- Vex's mint-token script remains in vex repo for separate-deployment scenarios; procur's MCP gets its own token issuance

**Code reuse from vex:**

- Tool schema definitions (`apps/mcp/src/tools.ts`)
- VexClient → ProcurClient (direct DB calls instead of HTTP)

### 5.9 Ingestion (procur → vex push, becoming internal)

**What vex has:**

- `/ingest/procur/leads` — receives operator pushes from procur match queue
- `/ingest/procur/contact-enrichments` — bidirectional contact data sync
- Webhook handlers for Resend, Twilio, form fills, website chat

**Migration target:**

- Procur has `apps/app/app/api/match-queue/[id]/push-to-vex/route.ts` and `apps/app/app/api/entities/[slug]/push-to-vex/route.ts` — these become `qualify-as-lead/route.ts` and `enrich-contact/route.ts`, doing the work in-process instead of POSTing to vex
- Webhook handlers for Resend, form fills, website chat port to procur as `apps/app/app/api/webhooks/*` (procur already has Clerk and Stripe webhooks here)
- Twilio webhooks active in Phase 7

**Code reuse from vex:**

- Webhook verifier logic for Resend and form
- Inbound translator logic for Resend, form fills, email-inbound, website chat
- Vex's `/ingest/procur/leads` schema validation becomes the internal lead-creation function signature (no API at this point)

---

## 6. Schema reconciliation

The merge adds 30+ new tables to procur. They're additive (no conflicts with procur's 65 existing tables), but there are explicit reconciliation choices for tables that overlap conceptually.

### 6.1 Vex tables that import directly (no overlap)

These tables don't exist in procur and import as new tables:

```
agent_runs, approvals, cost_ledger,
leads, campaigns, campaign_steps, campaign_enrollments, follow_ups,
touchpoints, threads, messages, activities,
fuel_deals, fuel_deal_cost_stack, fuel_deal_cashflow_events,
fuel_deal_scenarios, fuel_deal_counterparty_scores, fuel_deal_documents,
fuel_deal_participants, fuel_deal_market_context,
fuel_market_rates, freight_rates,
summaries, raw_events, events, embedding_chunks,
organization_products, organization_relationships,
port_events
```

### 6.2 Vex tables with procur equivalents

These required explicit reconciliation. **Decisions are locked in `docs/vex-into-procur-merge-decisions.md`.** Summary:

| Vex table | Procur table | Decision |
|---|---|---|
| `organizations` | `companies` (CRM-like) | Procur canonical. Vex `externalKeys` JSONB column added onto `companies` via ALTER. |
| `contacts` | New procur `contacts` table (separate from `entity-contact-enrichments`) | New table with FK to `entities.slug`. |
| `vessels` | `vessels` | Procur canonical. Vex agents point to procur's table. |
| `ports` | `ports` | Procur canonical. Same. |
| `ofac_screens` | `entity-sanctions-screens` | Procur canonical name; ALTER to add vex's richer columns (`list_source`, `screen_id`, `details` JSONB). |
| `procur_intelligence_snapshots` (vex) | (n/a in procur) | Drop. Was vex caching procur HTTP calls. With merge, no caching layer needed. |

### 6.3 Workspace and tenant scoping

**Decision (Phase 0 §2):** drop `tenant_id` from migrated tables; replace with `user_id` (Clerk ID) where ownership tracking matters. No `workspace` column in v1.

### 6.4 Indexes and partitions

Vex partitions some high-volume tables (raw_events, etc.). Procur doesn't currently partition. **Decision:** do not port partition setup in v1. Ship without partitions; revisit if tables grow large in production.

### 6.5 Migration mechanics

- One Drizzle migration per logical group (agent runtime / sales / comms / fuel deals / signals + voice in Phase 7)
- All migrations are additive — no destructive changes to existing procur tables in v1
- The reconciliation cases in §6.2 (`companies` external_keys, `entity_sanctions_screens` richer columns) are the **only** ALTER migrations in v1; the new `contacts` table is a new table not an ALTER

---

## 7. Code organization in procur after merge

The merge fits cleanly into procur's existing monorepo structure:

```
procur_dashboard/
├── apps/
│   ├── app/                  # Cole's operator app (target for most migration)
│   │   ├── app/
│   │   │   ├── api/
│   │   │   │   ├── deals/                  # NEW from vex
│   │   │   │   ├── follow-ups/             # NEW from vex
│   │   │   │   ├── leads/                  # NEW from vex
│   │   │   │   ├── communications/         # NEW from vex
│   │   │   │   ├── approvals/              # NEW from vex
│   │   │   │   ├── signals/                # NEW from vex
│   │   │   │   ├── calls/                  # NEW from vex (Phase 7)
│   │   │   │   ├── voice/                  # NEW from vex (Phase 7)
│   │   │   │   ├── webhooks/
│   │   │   │   │   ├── resend/             # NEW from vex
│   │   │   │   │   ├── form/               # NEW from vex
│   │   │   │   │   └── twilio/             # NEW from vex (Phase 7)
│   │   │   │   └── (existing procur API routes)
│   │   │   ├── deals/                      # NEW from vex
│   │   │   ├── follow-ups/                 # NEW from vex
│   │   │   ├── inbox/                      # NEW from vex
│   │   │   ├── marketing/                  # NEW from vex
│   │   │   ├── approvals/                  # NEW from vex
│   │   │   ├── signals/                    # NEW from vex
│   │   │   ├── calls/                      # NEW from vex (Phase 7)
│   │   │   ├── voice/                      # NEW from vex (Phase 7)
│   │   │   └── (existing procur web routes)
├── packages/
│   ├── db/
│   │   └── src/schema/
│   │       ├── (existing 65 schemas)
│   │       └── (NEW vex schemas added — agent-runs, approvals, leads, etc.)
│   ├── ai/
│   │   ├── src/
│   │   │   ├── agents/                     # NEW: ported vex agents
│   │   │   ├── agent-runner.ts             # NEW: vex AgentRunner
│   │   │   ├── approval-gate.ts            # NEW: vex ApprovalGate
│   │   │   ├── action.ts                   # NEW: vex ActionDescriptor
│   │   │   └── (existing procur ai)
│   ├── sanctions/                          # NEW: vex sanctions list integrations
│   │   └── src/
│   │       ├── ofac-sdn.ts
│   │       ├── uk-ofsi.ts
│   │       ├── eu-consolidated.ts
│   │       └── csl.ts
│   ├── integrations/                       # NEW: tavily, slack, twilio, voice-bridge
│   └── (existing procur packages)
└── services/
    ├── execution/                          # NEW: ported vex workflows
    │   └── src/trigger/
    │       ├── follow-up.ts
    │       ├── research.ts
    │       ├── campaign-enrollment.ts
    │       └── outbound-call.ts            # Phase 7
    └── (existing procur services)
```

Anti-pattern to avoid: creating an `@vex/*` package namespace inside procur. Vex code that ports into procur becomes procur code, in procur's package namespaces. The vex repo remains as a code reference, not a dependency.

---

## 8. Phased execution plan

The merge ships in seven phases. Each phase is independently shippable and provides incremental commercial value.

### Phase 0 — Preparation (3-5 days, no shipping)

Goal: Make all the cross-system decisions before touching code.

Deliverables:

- Schema reconciliation analysis confirmed (§6) — every overlap case has a documented decision
- Third-party replacement decisions confirmed (§4)
- Repository setup: vex repo cloned alongside procur; code reading and porting workflow established
- Voice scope confirmed (§5.5 / §6 / Phase 7): IN v1 per Cole's decision
- Branch strategy: phase-by-phase main-line PRs

Output: `docs/vex-into-procur-merge-decisions.md` committed to procur with the resolved decisions. ✅ **Done as of 2026-05-06.**

### Phase 1 — Database schema additions (3-5 days)

Goal: All new tables exist in procur. No code uses them yet.

Deliverables:

- Drizzle migration adding the 30+ new tables from §6.1 (additive, no conflicts)
- Drizzle migration adding new columns to procur's `companies` (external_keys JSONB) and `entity-sanctions-screens` (richer columns from vex's ofac_screens)
- New `contacts` table (separate from `entity-contact-enrichments`)
- Repository implementations ported from vex's `@vex/db` to `@procur/db`
- Domain types ported from vex's `@vex/domain` to a new `packages/domain/` (or merged into existing `packages/types/`)
- Schema and repository tests passing in procur's test setup
- No UI, no API, no agent execution yet — tables exist, repositories work

Phase 1 ships independently. Procur continues to function exactly as before; new tables are just present.

### Phase 2 — Agent runtime infrastructure (5-7 days)

Goal: ActionDescriptor + AgentRunner + ApprovalGate + cost_ledger + agent_runs work end-to-end in procur.

Deliverables:

- `packages/ai/src/action.ts` ported from vex (ActionDescriptor zod schema, ~890 lines, with vex-specific variants pruned where they don't fit single-user procur; voice variants kept per Phase 7 active)
- `packages/ai/src/agent-runner.ts` ported (AgentRunner class)
- `packages/ai/src/approval-gate.ts` ported
- `packages/ai/src/agents/types.ts` ported (AgentContext, AgentOutput, IAgent)
- Cost ledger interface unified with procur's existing ai-usage tracking
- A "hello world" agent (the simplest one — DailyBriefAgent or a stub) running through the full agent_runs → approvals → activity logging path
- Trigger.dev v3 task wrapping AgentRunner so agents can be triggered from cron, webhook, or chat command
- Approval queue API at `apps/app/app/api/approvals/`
- Approval queue UI at `apps/app/app/approvals/`

End of Phase 2: procur has an agent runtime and an approval queue. One agent works end-to-end. Other agents follow in subsequent phases without infrastructure rework.

### Phase 3 — Communications layer (5-7 days)

Goal: Procur receives inbound emails, threads them, surfaces them in inbox, drafts replies through agent.

Deliverables:

- Touchpoints, threads, messages, activities tables wired with repositories (already shipped in Phase 1; this is where they get used)
- Resend inbound webhook handler ported and live
- Resend inbound translator ported (creates touchpoint + thread + message rows from inbound webhook)
- Inbox API at `apps/app/app/api/communications/`
- Inbox UI at `apps/app/app/inbox/` and `apps/app/app/inbox/[id]/`
- EmailReplyDraftAgent ported and triggerable from inbox
- Templates UI at `apps/app/app/inbox/t/` (template management)
- Activities event types unified with procur's existing audit log

End of Phase 3: Cole receives email at a Resend-backed address, sees it in procur inbox, drafts replies through the AI agent, and everything is captured as activities.

### Phase 4 — Sales execution (5-7 days)

Goal: Procur runs leads, campaigns, follow-ups end-to-end.

Deliverables:

- Leads, campaigns, campaign_steps, campaign_enrollments, follow_ups tables wired with repositories
- Lead qualification API and UI
- Match-queue → lead conversion (replaces match-queue-push-to-vex with internal lead creation)
- Procur metadata sidecar pattern preserved (procur match-queue context attached to leads)
- LeadQualificationAgent and ResearchAgent ported and runnable
- FollowUpAgent ported and scheduled via Trigger.dev
- Follow-ups UI at `apps/app/app/follow-ups/`
- Campaign management UI at `apps/app/app/marketing/`
- ReactivationBatchAgent ported as scheduled Trigger.dev task
- Tavily integration ported (`packages/integrations/src/tavily.ts`) consumed by ResearchAgent
- **Cleanup:** delete `apps/app/lib/vex-client.ts`, `apps/app/app/api/match-queue/[id]/push-to-vex/route.ts`, `apps/app/app/api/entities/[slug]/push-to-vex/route.ts`. Procur stops *initiating* calls to vex.

End of Phase 4: Cole can promote a match-queue entry to a lead, run it through qualification and research, and follow up on it. The vex-to-procur push integration is now an internal in-process call.

### Phase 5 — Deal execution (7-10 days)

Goal: Procur runs full fuel deal modeling with cost stack, scenarios, market context, and counterparty scoring.

Deliverables:

- All fuel-deal-* tables wired with repositories
- Deal calculator ported as `packages/utils/src/deal-calculator.ts` with full test coverage
- DealEvaluatorAgent ported and runnable on deals
- DealMarketContextAgent ported, queries procur tables directly instead of HTTP
- Deal API at `apps/app/app/api/deals/`
- Deal list UI at `apps/app/app/deals/`
- Deal detail UI at `apps/app/app/deals/[id]/` with cost stack, cashflow timeline, scenarios, counterparty scores
- Deal-to-procur-intelligence connections live (counterparty scores reading procur's ownership graph and sanctions screens)
- Approval queue integration for deal lifecycle transitions

End of Phase 5: Cole can model fuel deals end-to-end in procur, with deal-evaluator and market-context agents running on every transition.

### Phase 6 — Sanctions and signals (3-5 days)

Goal: Procur has multi-list sanctions screening and proactive signal layer.

Deliverables:

- Sanctions list integrations ported as `packages/sanctions/`
- OFACScreeningAgent ported, runs on entity profile load and on draft→live deal transition
- Existing procur `entity-sanctions-screens` table unified with vex's richer column set
- Signals layer (proactive alert table) wired
- Signal rules ported from vex's `apps/worker/src/jobs/signals-job.ts` as Trigger.dev scheduled tasks
- Signals UI at `apps/app/app/signals/`
- Daily brief agent ported (DailyBriefAgent surfaces signals + follow-ups + approvals in one digest)
- Slack integration ported (`packages/integrations/src/slack.ts`); DailyBrief surfaces a Slack message alongside the Resend email
- **Cutover:** vex deployment turned off. Delete `apps/app/app/api/intelligence/match-outcome/route.ts` and `apps/app/app/api/intelligence/entity/[slug]/sanctions-screen/route.ts`. Remove `VEX_API_BASE_URL`, `VEX_API_TOKEN`, `PROCUR_API_TOKEN` env vars. Drop `match_outcome_events` after one-shot copy of historical rows into `feedback_events`.

End of Phase 6: procur has full sanctions coverage, proactive signal surfacing, Slack notifications, and is the single operational system. Vex is offline.

### Phase 7 — Voice (7-10 days, IN v1)

Goal: Procur supports outbound calls via Twilio with voice agent and transcript processing.

Per Phase 0 decision §1, voice is in scope for v1.

Phase 7 deliverables:

- Twilio integration ported with web SDK and server-side adapter
- Voice bridge logic (`voice-bridge.ts`) ported
- Outbound call workflow as Trigger.dev task (call lifecycle: initiated → ringing → connected → ended → transcribed → summarized)
- Calls list and detail UI at `apps/app/app/calls/`
- Voice operator UI at `apps/app/app/voice/`
- Transcript processing (Whisper or equivalent) ported
- Approval queue integration for call ActionDescriptors
- Twilio webhook handler at `apps/app/app/api/webhooks/twilio/route.ts`

Twilio voice SDK has browser-side dependencies that complicate procur's Next.js deployment; expect Phase 7 to require non-trivial integration tuning. Twilio also adds new env vars (account SID, auth token, phone number, app SID) that must be set in Vercel before Phase 7 ships.

---

## 9. Dependencies and ordering

```
Phase 0 (decisions) ──> Phase 1 (schema) ──> Phase 2 (agent runtime)
                                                 │
                          ┌──────────────────────┼──────────────────┐
                          ↓                      ↓                  ↓
                    Phase 3 (comms)        Phase 4 (sales)    Phase 5 (deals)
                          │                      │                  │
                          └──────────┬───────────┴──────────────────┘
                                     ↓
                              Phase 6 (sanctions+signals; vex cutover)
                                     │
                                     ↓
                              Phase 7 (voice)
```

Phase 1 is a hard blocker — nothing else ships without the schema in place. Phase 2 is a hard blocker for everything that uses agents (Phase 3 reply drafting, Phase 4 lead qualification, Phase 5 deal evaluation, Phase 6 sanctions screening, Phase 7 call agents).

Phases 3, 4, 5 can ship in parallel after Phase 2 is complete, if engineering capacity allows. Phase 6 depends on entities being well-populated (which Phase 5 deal flow tends to drive). Phase 7 is independent and can ship anytime after Phase 2 but is sequenced after Phase 6 because the cutover from vex frees up the URL/auth boundary work in Phase 7.

---

## 10. Total effort estimate

| Phase | Effort | Cumulative |
|---|---|---|
| Phase 0 — Preparation | 3-5 days | 3-5 days |
| Phase 1 — Schema | 3-5 days | 6-10 days |
| Phase 2 — Agent runtime | 5-7 days | 11-17 days |
| Phase 3 — Communications | 5-7 days | 16-24 days |
| Phase 4 — Sales | 5-7 days | 21-31 days |
| Phase 5 — Deals | 7-10 days | 28-41 days |
| Phase 6 — Sanctions+signals+cutover | 3-5 days | 31-46 days |
| Phase 7 — Voice (IN v1) | 7-10 days | 38-56 days |

**Realistic full-merge timeline including voice: 7-10 weeks of focused engineering time.**

This is a meaningful investment. It should not start until:

- Current Venezuela contractor engagement work has reached a stable phase
- The active build sprint pace stabilizes such that this merge is the priority, not parallel to other sprints
- Cole has explicit clarity that operating one unified system outweighs the cost of the merge work

---

## 11. What this brief deliberately doesn't include

- Specific implementation code or function signatures (Claude Code generates these at implementation time)
- Vex-specific test fixture migration (most fixtures require regeneration in procur context)
- Per-agent prompt versioning strategy (vex uses prompt versions; procur should adopt the same pattern but the migration is per-agent at port time)
- Deployment cutover plan (this brief is repo-side; deployment has its own brief if needed)
- Vex repo deprecation (vex stays separate; the brief doesn't propose archiving it)
- Customer/tenant migration (procur is single-user per Phase 0 §2; if this changes, multi-tenant is a separate brief)
- Performance benchmarking targets (set at implementation time per phase)
- Specific Drizzle migration ordering within a phase (Phase 1 will need careful per-migration ordering; details emerge during implementation)
- Trigger.dev task naming and routing keys conventions (defer to implementation; procur has existing patterns to align with)

---

## 12. Open questions resolved at Phase 0

All seven open questions resolved in `docs/vex-into-procur-merge-decisions.md`:

1. Voice scope — **IN v1** (Phase 7 active)
2. Workspace scoping — **single-user only**
3. Vex retention — **reference-only, deployment offline**
4. Vex production data — **empty tables, fresh start**
5. Tavily — **port** (Phase 4)
6. Slack — **port** (Phase 6)
7. Branch strategy — **phase-by-phase main-line PRs**

---

## 13. Discipline notes for implementation

When this brief gets executed, three reminders:

**(1) Phase 0 ships first.** ✅ Done as of 2026-05-06. Decisions are locked in `docs/vex-into-procur-merge-decisions.md`.

**(2) Resist scope creep within phases.** Each phase has a bounded scope. The temptation when porting code is to "while we're in here, also fix [unrelated thing]." Don't. Each phase ships its bounded value and the next phase begins.

**(3) Vex stays as separate repo, but vex code in procur is procur code.** Do not create `@vex/*` package namespaces inside procur. Do not import vex packages as dependencies. The vex repo is a code reference, not a runtime dependency. Code that ports lives in procur's package namespaces and is owned by procur going forward.

---

End of brief.
