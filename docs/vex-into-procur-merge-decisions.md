# Vex-into-Procur Merge — Phase 0 Decisions

**Status:** Locked. These decisions guide Phases 1–7 implementation.
**Owner:** Cole
**Decided:** 2026-05-06
**Source brief:** `docs/vex-into-procur-merge-brief.md` (Cole's planning brief, dated 2026-05-06).
**Implementation plan:** `/root/.claude/plans/distributed-leaping-tower.md` (Claude Code session plan; for ongoing reference).

This document closes brief §12 and §6.2/§6.3 so Phase 1 can ship without ambiguity. Each item is a binding decision unless explicitly revisited in a future Phase 0.x amendment.

---

## 1. Voice scope — IN v1

**Decision:** Voice features ship as part of the merge, not as a deferred add-on.

Phase 7 joins the active timeline:
- Twilio integration (web SDK + server-side adapter)
- Voice bridge logic (`voice-bridge.ts`) ported
- Outbound call workflow as a Trigger.dev v3 task (lifecycle: initiated → ringing → connected → ended → transcribed → summarized)
- `apps/app/app/calls/` and `apps/app/app/calls/[id]/` UI
- `apps/app/app/voice/` operator UI
- Transcript processing
- Approval queue integration for call ActionDescriptors

This overrides the brief's recommended default (defer indefinitely). Timeline impact: +7–10 days per brief §10. Total realistic merge timeline becomes **7–10 weeks** of focused engineering, including voice.

The Twilio voice SDK has browser-side dependencies that complicate Next.js 15 deployment; expect Phase 7 to require non-trivial integration tuning. Twilio also adds new env vars (account SID, auth token, phone number, app SID) that must be set in Vercel before Phase 7 ships.

---

## 2. Workspace scoping — single-user only

**Decision:** Drop `tenant_id` columns from all migrated tables. Use Clerk user IDs for ownership tracking where it matters (leads, follow-ups, campaigns, deals, agent_runs, approvals).

No `workspace` column in v1. If VTC / Vector Antilles / Stabroek isolation becomes operationally painful, revisit as a separate brief — but the current operational pattern doesn't require it.

**Phase 1 implication:** vex schema files port verbatim except `tenant_id` columns are stripped during the port and replaced with `user_id` (Clerk ID) where the row needs an owner. Vex's tenant-scoped query helpers translate to user-scoped helpers; multi-tenant enrollment reconciliation logic simplifies to single-user.

---

## 3. Vex retention — reference-only, deployment offline

**Decision:** Vex deployment goes offline at end of Phase 6. Vex repo (`cjkootch/vex`) is retained as code reference only; no runtime dependency.

Cutover plan (already locked into the implementation plan):
- **End of Phase 4:** delete `apps/app/lib/vex-client.ts`, `apps/app/app/api/match-queue/[id]/push-to-vex/route.ts`, `apps/app/app/api/entities/[slug]/push-to-vex/route.ts`. Procur stops *initiating* calls to vex.
- **End of Phase 6:** vex deployment turned off; delete `apps/app/app/api/intelligence/match-outcome/route.ts` and `apps/app/app/api/intelligence/entity/[slug]/sanctions-screen/route.ts`; remove `VEX_API_BASE_URL`, `VEX_API_TOKEN`, `PROCUR_API_TOKEN` env vars from procur and from Vercel project settings. Procur stops *receiving* calls from vex.

After cutover, every code path that mentioned "vex" is either ported into procur or deleted. The `cjkootch/vex` repo continues to exist on disk but no longer runs anywhere.

---

## 4. Vex production data — empty tables, fresh start

**Decision:** No data migration from vex. Phase 1 ships additive tables empty; vex's history (leads, deals, threads, agent runs) does not migrate. Procur accumulates fresh data once Phases 3–6 ship.

Phase 1.5 (one-shot tsx data migration script) is **not** in scope. The repository will not ship `packages/db/src/migrate-vex-data.ts`.

If, post-merge, Cole decides he wants specific historical rows preserved (e.g., a list of warm leads from a specific campaign), a manual one-shot import script can be written ad hoc. The default plan is fresh start.

---

## 5. Tavily — port

**Decision:** Port Tavily into procur as a small self-contained integration. Used by ResearchAgent in Phase 4.

Implementation lands in Phase 4 alongside ResearchAgent; no Phase 1 change. Tavily API key goes to env (`TAVILY_API_KEY`), client wrapper lives in `packages/integrations/` or `packages/ai/src/integrations/tavily.ts` (pick at port time based on what fits the surrounding code).

---

## 6. Slack — port

**Decision:** Port vex's Slack integration. Useful for operator notifications (deal events, approvals, signals).

Implementation lands alongside Phase 6 (signals + DailyBrief notifications). Slack webhook URL goes to env (`SLACK_WEBHOOK_URL`); client wrapper at `packages/integrations/src/slack.ts`. Phase 6 DailyBriefAgent surfaces a Slack message in addition to the Resend email.

---

## 7. Branch strategy — phase-by-phase main-line PRs

**Decision:** Each phase ships as its own PR(s) merged to main. No long-running merge branch.

Matches procur's existing PR cadence. Avoids the merge-hell pattern of holding 6+ weeks of work in a single branch. Each phase's PR is reviewable in isolation, can be squashed, and unblocks the next phase cleanly.

---

## Schema reconciliation locks (closes brief §6.2)

| Vex table | Decision | Procur target |
|---|---|---|
| `organizations` | **Procur canonical.** Vex writes route to `companies` (CRM-like), not `entities` (intelligence warehouse). | `companies` table; add `external_keys` JSONB column to it via ALTER. |
| `contacts` | Add new `contacts` table in procur (separate from `entity_contact_enrichments`). | New `contacts` with FK to `entities.slug`. |
| `vessels` | **Procur canonical.** Vex's vessels schema does not import; procur's data is more comprehensive. | Vex agents that depend on vessels point to procur's `vessels` table. |
| `ports` | **Procur canonical.** Same logic as vessels. | Vex agents point to procur's `ports`. |
| `ofac_screens` | **Procur canonical name.** Merge vex's richer column set onto `entity_sanctions_screens` via ALTER. | `entity_sanctions_screens` with added columns: `list_source`, `screen_id`, `details` (JSONB). |
| `procur_intelligence_snapshots` (vex) | **Drop.** Was vex caching procur HTTP calls; with merge, no caching layer needed. | Vex agents query procur tables directly via Drizzle. |

ALTER migrations on `companies` (`external_keys` JSONB) and `entity_sanctions_screens` (richer columns) are the **only** mutating-existing-table migrations in v1. All other migrations are additive.

---

## Decisions intentionally deferred to implementation time

These are flagged in the source brief but don't block Phase 1; they get answered when their phase ships:

- **Activity event types harmonization** (brief §5.1, §5.4): how vex's `activities` table integrates with procur's existing `tool_call_logs` and audit trails. Decided at Phase 3 implementation time.
- **Trigger.dev task naming/routing conventions** (brief §11): align with procur's existing naming when porting workflows. Decided per-phase as workflows port.
- **Per-agent prompt versioning strategy** (brief §11): vex uses prompt versions; procur should adopt the same pattern. Per-agent decision at port time.
- **Performance benchmarking targets** (brief §11): set per phase based on observed real-world load.
- **Drizzle migration ordering within Phase 1** (brief §11): determined when migrations are written; ordering matters for FK dependencies (e.g., agent_runs before approvals).

---

## Phase 0 sign-off

All seven brief §12 questions resolved. All schema reconciliation cases in brief §6.2 locked. Phase 1 (schema additions) is unblocked.

Next action: Phase 1 PR adding the ~30 new tables + the two ALTER migrations + the new `contacts` table, with `IF NOT EXISTS` guards and proper `--> statement-breakpoint` separators per CLAUDE.md migration footguns.
