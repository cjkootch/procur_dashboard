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

- **ISO-2 country codes** — country params use
  `.regex(/^[A-Z]{2}$/, '...readable error with examples...')`.
  Bare `.length(2)` produces a useless Zod error and the model
  retries with random country names.
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
