# MCP Server — Procur as an MCP-Compatible Tool Surface for External AI Clients

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-05-05
**Repo:** `cjkootch/procur_dashboard`
**Companion to:** `docs/strategic-vision.md` (procur as the operational backbone), `docs/assistant-tools-spec.md` (the chat tool registry this re-exposes), `docs/apollo-integration-brief.md` (Apollo tools surfaced through MCP)

This brief specifies an MCP (Model Context Protocol) server that lets external AI clients — Claude Desktop, ChatGPT custom GPTs, Cursor, Continue.dev, and any MCP-compatible host — access procur's catalog query layer as native tool calls. Operators can ask Claude Desktop "find me Caribbean fuel distributors that raised in the last 12 months" or have a ChatGPT custom GPT pull procur's customs-flow data into a research workflow without leaving the host application.

The server re-exposes a curated subset of the existing chat-tool registry (`packages/catalog/src/tools.ts`) over MCP's standard transport. Tenancy + auth happens at the connection layer via per-tenant API keys; tool calls execute scoped to the connecting tenant's `company_id`, identical to how the in-app assistant works today.

The work is bounded: 1 migration (api keys + call log), 1 new HTTP handler at `app/api/mcp/route.ts`, a curated tool whitelist + adapter that translates the existing `defineTool` registry to MCP's tool schema, and a settings UI for key management. Estimated effort: **3–5 days** end-to-end.

---

## 1. Why this brief exists

Procur's commercial value compounds when its data is reachable from the surfaces operators already work in. Today operators go to the procur web app to query the catalog; if they want to use a different host (Claude Desktop for long-form research, ChatGPT for a presentation prep, Cursor for a code-and-data workflow), they have to copy-paste between applications. That friction is the limiting factor on procur's leverage as an analytical backbone.

MCP is the right answer to this because:

**(a) Standardization.** MCP is the protocol Anthropic, OpenAI (via custom GPTs), Google, and the indie tooling ecosystem (Cursor, Continue, Cline, Zed) have converged on for "external tools an AI client can call." Building an MCP server reaches all of those clients with one implementation, instead of N proprietary integrations.

**(b) Tool reuse, not rewrite.** The existing `buildCatalogTools()` registry already defines 57 tools with Zod-validated input schemas, structured outputs, and telemetry. MCP's tool shape (name + JSON Schema input + JSON output) is a near-direct mapping. The MCP server adapter is ~200 lines, not a rewrite.

**(c) Reach without copy-paste.** A ChatGPT custom GPT configured against the procur MCP endpoint can answer "what's the Caribbean diesel benchmark today" or "who are the Tier-1 fuel buyers in Jamaica" by calling procur tools directly. Same for Claude Desktop in research-and-write workflows. Same for Cursor when an operator is wiring a downstream integration and needs a procur lookup mid-edit.

**(d) Per-tenant scoping is built-in.** Procur tools already accept `companyId` for tenant scoping (supplier approvals, KYC state, alerts). The MCP server attaches the connecting tenant's `companyId` to every tool call, so external clients see the same tenant-isolated view they see in the web app. No info leakage; no shared global view.

What this brief explicitly is NOT: a public API for arbitrary HTTP clients. The MCP audience is AI hosts that want tool-calling. We're not exposing REST or GraphQL; if a downstream wants raw data access, that's a separate decision.

---

## 2. Scope and non-scope

### 2.1 In scope

- **Single HTTP MCP endpoint** at `https://app.procur.app/api/mcp`, implementing the MCP Streamable HTTP transport (the modern HTTP transport that supersedes the stdio + SSE pair for hosted servers)
- **Per-tenant API key authentication** — a new `mcp_api_keys` table, key generation UI at `/settings/integrations/mcp`, key carries `company_id` and authenticated user (so operator-scoped tools work)
- **Tool call log** — every MCP call gets a row in `mcp_tool_call_log` for observability + abuse detection. Mirrors the `apollo_credit_log` pattern.
- **Curated tool whitelist** — initial set of ~15-20 read-only, tenant-scoped query tools. The existing `defineTool` registry is the source of truth; MCP server filters by allowlist.
- **Connection guides** — a `/settings/integrations/mcp` page that surfaces the URL + an active key + copy-paste config snippets for Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`), ChatGPT custom GPT (Actions/MCP), Cursor (`mcp.json`), Continue.dev.
- **Per-key rate limit** — internal token bucket sized for 1,000 calls/hour/key. Burst-tolerant; surfaces a `429`-equivalent MCP error when exceeded.
- **Documentation page** describing the available tools, their inputs, what's NOT exposed, and how the tenancy model works.

### 2.2 Out of scope

- **Write tools.** v1 is read-only. `set_supplier_approval`, `attach_document_to_entity`, `add_to_pursuit_pipeline`, `create_alert_profile`, and the Apollo enrichment paid endpoints (`/people/match`, `/people/bulk_match`) are NOT exposed. External AI clients can read procur; they can't write to it. v2 may add curated write tools after we see real usage patterns.
- **`compose_proposal_skeleton`.** This tool is tightly coupled to the in-app assistant's system-prompt discipline (the "Proposal composition workflow" hard rule). Exposing it via MCP without the discipline produces drafts that ignore counsel-validation flags and destination-exclusion triggers. Defer until we can replicate the discipline as MCP-side guidance.
- **MCP Resources.** The Resources primitive lets clients fetch arbitrary files / blobs. Not in scope — procur's documents (`entity_documents`, `library`) have access controls that don't translate cleanly to a "list and fetch" model. Tools-only.
- **MCP Prompts.** Templated prompts that hosts can offer to users. Defer until we have a clear use case.
- **MCP Sampling.** Letting the procur server make LLM calls back through the client. Defer; not needed for query tools.
- **OAuth authentication.** API keys are simpler to ship, simpler to revoke, simpler to support across all MCP hosts. OAuth is a v2 consideration if a host (e.g. enterprise ChatGPT) requires it.
- **Stdio transport.** We're hosted; HTTP is the natural fit. If an enterprise customer needs a self-hosted bridge, they can run an `mcp-proxy` shim themselves.
- **Per-tool granular permissions.** All keys grant access to the full curated tool set. Per-tool scoping is a v2 consideration once we see what hosts actually request.

### 2.3 Why this is bounded

The MCP protocol is mature; the SDK (`@modelcontextprotocol/sdk`) handles the transport plumbing, tool discovery, and JSON-RPC framing. Most of the work is the adapter layer — translating procur's `defineTool` shape to MCP's tool shape — and the auth/observability glue. We're not designing a new protocol; we're connecting two well-defined surfaces.

---

## 3. Architecture

### 3.1 Endpoint shape

A single Next.js Route Handler at `apps/app/app/api/mcp/route.ts`:

```typescript
import { handleMcpRequest } from '@procur/mcp-server';

export async function POST(request: Request) {
  return handleMcpRequest(request);
}

export async function GET(request: Request) {
  return handleMcpRequest(request);
}
```

The handler implements MCP's Streamable HTTP transport: clients POST JSON-RPC requests, the server responds with JSON or SSE-streamed messages. The `@modelcontextprotocol/sdk` server transport handles framing; procur owns the tool registry + auth.

Edge runtime is not used — MCP requests can take >1s for complex catalog queries, and the existing chat tools depend on `db` (Neon HTTP) which works fine in the Node runtime.

### 3.2 Authentication flow

1. Operator generates an API key from `/settings/integrations/mcp`. Key format: `procur_mcp_<random32>` (prefix makes leaked keys grep-able in logs / GitHub secret scanning). Stored hashed in the database; raw key shown once on creation.
2. External client (Claude Desktop, etc.) sends requests with `Authorization: Bearer <key>`.
3. The MCP handler hashes the incoming key and looks up the row. Row carries `company_id` and `created_by_user_id`. Both flow into the tool-call context for tenant scoping + audit attribution.
4. Revoked keys are kept (status = 'revoked') so audit-log references stay resolvable.

### 3.3 Tool execution path

```
External client (Claude Desktop / ChatGPT / Cursor)
  │  POST /api/mcp
  │  Authorization: Bearer procur_mcp_<…>
  ▼
apps/app/app/api/mcp/route.ts
  │
  ▼
@procur/mcp-server (new package)
  │  - hash key, look up tenant
  │  - rate-limit check
  │  - log call to mcp_tool_call_log
  │  - filter buildCatalogTools() to whitelist
  ▼
Existing tool handler from packages/catalog/src/tools.ts
  │  - same Zod schema validation
  │  - same withToolTelemetry wrapper
  │  - same db queries scoped to company_id
  ▼
Tool result → MCP response
```

The tool registry is shared with the in-app assistant. There's no parallel implementation. When we add a new tool to `buildCatalogTools()`, MCP gets it automatically — IF the tool is in the whitelist.

### 3.4 Tool shape translation

procur's `defineTool` shape:

```typescript
{
  description: string,
  parameters: ZodSchema,
  handler: (args, ctx) => Promise<Result>,
}
```

MCP's tool shape:

```typescript
{
  name: string,
  description: string,
  inputSchema: JSONSchema,
}
```

The adapter uses `zod-to-json-schema` to translate Zod schemas to JSON Schema, surfaces the description verbatim, and routes execution back through the original handler. ~50 lines of code.

---

## 4. Schema additions

### 4.1 `mcp_api_keys`

```sql
CREATE TABLE mcp_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /** Hashed key (sha-256 of the raw key + a per-instance pepper).
      The raw key is shown once at creation and never persisted. */
  key_hash text NOT NULL UNIQUE,

  /** Human-readable identifier — operator picks one at creation,
      e.g. "Claude Desktop", "ChatGPT custom GPT", "research workspace". */
  name text NOT NULL,

  /** Tenant scope. Every MCP call from this key carries this
      company_id into the tool execution context. */
  company_id uuid NOT NULL REFERENCES companies(id),

  /** Audit attribution — which user generated the key. Used in
      audit_log when MCP-driven actions land. */
  created_by_user_id uuid NOT NULL REFERENCES users(id),

  /** Last 4 chars of the raw key, for "Claude Desktop … 7f3c"
      display. The full key is only ever in the operator's
      external client config. */
  display_suffix text NOT NULL,

  /** 'active' | 'revoked'. Revoked keys stay around for audit
      attribution but are rejected at auth-check. */
  status text NOT NULL DEFAULT 'active',

  /** ISO 8601 — populated on every successful tool call. Drives
      the "last used" indicator in the settings UI. */
  last_used_at timestamp,

  /** Total successful tool calls. Surfaced in settings as a
      coarse signal of which keys are actually in use. */
  total_calls integer NOT NULL DEFAULT 0,

  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX mcp_api_keys_company_idx ON mcp_api_keys (company_id);
CREATE INDEX mcp_api_keys_status_idx ON mcp_api_keys (status);
```

### 4.2 `mcp_tool_call_log`

One row per MCP tool call. Mirrors `apollo_credit_log` for observability.

```sql
CREATE TABLE mcp_tool_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid REFERENCES mcp_api_keys(id),
  company_id uuid REFERENCES companies(id),
  tool_name text NOT NULL,
  /** 'success' | 'tool_error' | 'auth_failed' | 'rate_limited'
      | 'tool_not_whitelisted' | 'invalid_input'. */
  outcome text NOT NULL,
  duration_ms integer,
  /** Input args hash for dedup detection. NOT the raw args — those
      can carry sensitive criteria. */
  args_hash text,
  /** Free-text on the failure case. Empty for success. */
  error_message text,
  /** MCP host identifier from the User-Agent header when available
      (Claude Desktop, ChatGPT, Cursor, etc.). Useful for fleet
      observability. */
  host_identifier text,
  called_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX mcp_tool_call_log_called_at_idx ON mcp_tool_call_log (called_at);
CREATE INDEX mcp_tool_call_log_api_key_idx ON mcp_tool_call_log (api_key_id);
CREATE INDEX mcp_tool_call_log_company_called_at_idx
  ON mcp_tool_call_log (company_id, called_at);
```

---

## 5. Tool selection (v1 whitelist)

Selection criteria:
1. **Read-only.** No writes in v1.
2. **Tenant-scoped.** Tool must work correctly when called with a single `company_id` (not require an authenticated user identity beyond tenant).
3. **Self-contained.** Tool description + schema is enough for the model to use it correctly without additional system-prompt scaffolding.
4. **High operator value when used outside procur.** Research workflows, supplier discovery, market lookups.

### 5.1 Initial whitelist

**Catalog discovery (rolodex):**
- `lookup_known_entities` — analyst-curated buyer/seller/trader rolodex
- `find_buyers_for_offer` — given a cargo, find candidate buyers
- `find_competing_sellers` — given a sell side, find competitors
- `find_caribbean_fuel_buyers` — Caribbean fuel buyer rolodex query
- `analyze_supplier` — full supplier dossier

**Market intelligence:**
- `lookup_customs_flows` — Eurostat Comext + cross-source customs data
- `analyze_country_trade_pattern` — country-level trade signal aggregation
- `get_market_snapshot` — Brent / WTI / refined-product spot benchmarks
- `get_commodity_price_context` — commodity-grade benchmark context
- `get_freight_estimate` — voyage-based freight rate estimate
- `get_crude_basis` — basis differential vs Brent for named grades

**Crude grade / refinery analytics:**
- `list_crude_grades`, `lookup_crude_assay`, `view_crude_grade_detail`
- `find_refineries_for_grade`, `find_grades_for_refinery`
- `lookup_refinery_import_context`

**Catalog templates (read-only):**
- `lookup_deal_structure_template`
- `lookup_commission_structures`

**Apollo (read-only):**
- `lookup_apollo_org` — cached Apollo snapshot for a known entity
- `discover_orgs_by_criteria` — paid Apollo search (logged + rate limited)
- `find_decision_makers_at_entity` — free Apollo people search
- `find_recent_funding_events` — recent funding-event discovery

Total: ~22 tools. The full registry has 57; we filter to roughly 40% of it.

### 5.2 Explicitly NOT exposed in v1

- **Write tools** — `set_supplier_approval`, `attach_document_to_entity`, `add_to_pursuit_pipeline`, `create_alert_profile`
- **Composer tools** — `compose_proposal_skeleton`, `compose_deal_economics` (these depend on system-prompt discipline that isn't expressible in MCP yet)
- **Apollo enrichment** — `/people/match`, `/people/bulk_match` (paid, requires UI confirmation per the Apollo brief discipline)
- **Pricer tools** — `evaluate_target_price`, `evaluate_multi_product_rfq` (heavy logic, results often need follow-up reasoning the in-app assistant provides)

### 5.3 Future expansion path

After 60 days of v1 usage we'll have telemetry showing:
- Which tools are most-called from MCP hosts (signal: expand similar tools)
- Which tools fail most often with `tool_error` (signal: tighten descriptions or input schemas)
- Which hosts call which tools (signal: per-host tool curation if needed)

v2 may add: curated write tools, OAuth auth, MCP Resources for document access, per-key tool scoping.

---

## 6. Settings UI

A new page at `apps/app/app/settings/integrations/mcp/page.tsx`:

```
MCP integration                                  [ + Generate new key ]
─────────────────────────────────────────────────────────────────────
Endpoint URL    https://app.procur.app/api/mcp           [ Copy ]

Active keys

  Claude Desktop                                 last used 2h ago
  procur_mcp_…7f3c                              812 calls    [ Revoke ]

  ChatGPT custom GPT                             last used 4d ago
  procur_mcp_…1aa9                              45 calls     [ Revoke ]

Connection guides
  > Claude Desktop                              [ Show config snippet ]
  > ChatGPT custom GPT                          [ Show config snippet ]
  > Cursor                                      [ Show config snippet ]
  > Continue.dev                                [ Show config snippet ]

Available tools (22 read-only)
  > Catalog discovery (5)
  > Market intelligence (6)
  > Crude grade analytics (6)
  > Catalog templates (2)
  > Apollo (3)
```

Generate-new-key flow:
1. Operator clicks button → modal asks for a name ("Claude Desktop", "research workspace")
2. Server generates key, hashes it, persists row, returns raw key + suffix
3. Modal shows the raw key with a one-shot "Copy" + "Reveal" warning that this is the only time they'll see it
4. After modal close, the operator's settings page only shows the suffix going forward

Revoke flow: one click; status updates immediately; subsequent calls with the key fail auth.

---

## 7. Operational sequencing

**Day 1** — Schema + key management
- Migration adding `mcp_api_keys` + `mcp_tool_call_log`
- `@procur/mcp-server` package skeleton with feature flag
- Settings UI for key generate / list / revoke (no MCP traffic yet)

**Day 2** — MCP transport + adapter
- `apps/app/app/api/mcp/route.ts` route handler
- Adapter from `defineTool` registry → MCP tool shape (`zod-to-json-schema`)
- Auth check (key hash lookup)
- Rate limiter (per-key token bucket, 1000/hr)
- Tool-call log writeback

**Day 3** — Tool whitelist + tenant scoping
- Curated whitelist file
- Tenant-scoped execution (`companyId` flowed into every handler call)
- End-to-end test from Claude Desktop against dev server

**Day 4** — Connection guides + docs
- Per-host config snippets in the settings UI
- `/docs/mcp` public docs page (similar shape to existing API docs)

**Day 5** — Validation + polish
- Telemetry queries for the admin observability page
- Test against ChatGPT custom GPT, Cursor, Continue
- Documentation pass

Total: 3-5 days. Day 4 is the longest unknown — getting custom-GPT MCP setup right requires testing against OpenAI's specific config format.

---

## 8. Security considerations

**API key storage.** Hashed with sha-256 + per-deployment pepper (env var). The raw key is shown once; lost keys require generating a new one. Keys aren't recoverable.

**Tenant isolation.** Every MCP call carries `company_id` from the API key into the tool handler context. The tools already filter rolodex / supplier_approvals / contacts / alerts by `company_id`. Cross-tenant queries are impossible.

**Rate limiting.** Per-key token bucket: 1,000 calls/hour. This is high enough for any reasonable AI workflow, low enough to detect abuse early. When tripped, returns MCP error code `-32000` ("Server error") with message "Rate limit exceeded".

**No PII leakage.** The tool whitelist excludes:
- Per-user notification queries (operator-scoped, not tenant-scoped)
- Document attachment tools (could leak uploaded files)
- Audit log queries (could surface user action history)

Read-only tools that DO surface PII (contact names, emails) only return enrichment data the operator's tenant has already accumulated. No cross-tenant person data ever flows out.

**Apollo cost containment.** The Apollo discovery tool (`discover_orgs_by_criteria`) is paid. A misbehaving MCP key could spike the Apollo bill. Mitigation:
- The 1,000-call/hr per-key rate limit caps theoretical worst-case
- The existing per-tenant per-day Apollo enrichment cap (Day 3) still applies — and we're not exposing the enrichment endpoints over MCP at all
- Discovery calls (search-only) do consume credits; they're rate-limited but unbounded daily. v2 may add a per-key daily call budget.

**Audit log.** MCP tool calls write to `mcp_tool_call_log`. Combined with `audit_log` (which captures any state-mutating action), this gives a full forensic trail. v1 has no write tools, so audit_log entries from MCP traffic = zero.

**Key rotation.** No automatic rotation. Operators rotate manually by revoking + re-generating. The settings UI surfaces "last used 67d ago" so dormant keys are visible.

---

## 9. What this brief deliberately doesn't include

- **MCP server in services/ai-pipeline.** The MCP server lives in `apps/app/api/mcp/route.ts` because it needs Vercel deployment to share the database connection + env config with the app. A separate service would duplicate the auth + db wiring.
- **Self-hosted server distribution.** Procur is SaaS; no self-hosted v1.
- **`procur` CLI.** External CLI tooling for procur is a separate brief. MCP-via-Claude-Desktop covers most "use procur from anywhere" workflows.
- **Webhooks** for procur → external host notifications. Out of scope; defer to a separate notifications brief if real demand surfaces.
- **MCP server as a public marketplace listing.** Anthropic is curating a marketplace of MCP servers; procur isn't listed publicly because it's tenant-scoped commercial software, not a public data source.

---

## 10. Success metrics

After 30 days of v1:

- **Active key count.** How many tenants have generated at least one key. Target: >40% of paid tenants. Lower means the integration isn't reachable enough — UI surface is buried or guides are unclear.
- **Calls per active key per week.** Median + p90. Median <5 means keys are being generated then forgotten (UI/onboarding issue); p90 >5,000 might signal abuse worth investigating.
- **Tool diversity.** How many distinct tools are called per key per week. Low diversity (1-2 tools) means the host is using procur for one thing only; high diversity (>10) means it's becoming a general-purpose backbone — the strategic goal.
- **Outcome distribution.** Of all MCP calls, % that are `success` vs `tool_error` vs `invalid_input`. >5% `invalid_input` signals a tool description problem; >2% `tool_error` signals a handler bug.

After 90 days:

- **Cross-host adoption.** What share of active keys are in use from each host (Claude Desktop / ChatGPT / Cursor / other). Validates the "MCP reaches multiple hosts with one implementation" thesis.
- **Tool-call volume vs in-app assistant call volume.** Ratio of MCP-driven tool calls to in-app-assistant tool calls. High ratio (>0.5) means MCP is genuinely shifting where operators do work — the success scenario for this brief.

---

## 11. Open decisions before build

1. **Per-key daily call budget?** Default no daily cap, just the 1,000/hr rate limit. Worth confirming we're not concerned about Apollo discovery cost spikes from a long-running MCP-host workflow.
2. **Whitelist scope on day 1.** I've proposed ~22 tools; happy to start narrower (say 10 — just the rolodex + market intelligence core) and expand once we see usage. Or include all 22 from the start. This is the easiest dial to turn and barely affects implementation cost.
3. **Should `compose_proposal_skeleton` be exposed eventually?** It's tightly coupled to the in-app assistant's system-prompt discipline; the brief defers it. v2 might re-expose it with MCP-side guidance attached, but that requires Anthropic's Prompts primitive support to be stable across hosts. Worth a yes/no check on whether the operator wants this for v2.
4. **OAuth in v2?** Pure API-key v1 is simplest. Some enterprise hosts (newer ChatGPT business / Anthropic Console) prefer OAuth. Track demand and revisit at the 60-day mark.
5. **Public tool discoverability?** v1 settings page lists tools to operators but doesn't expose them at a public docs URL. If we want indie-developer adoption, a public `/docs/mcp/tools` page is worth ~half a day. Defer until demand.
