# Brief implementation status

**Last refreshed:** 2026-05-12
**Purpose:** single authoritative status for every brief in `docs/`. Read
this FIRST before assessing what's left to build — individual briefs'
top-of-file "Status:" lines drift and have repeatedly fooled AI sessions
into recommending shipped work.

When status here disagrees with a brief's own status line, **this file is
the source of truth.** Update this file when you ship something against
a brief; don't try to keep both in sync.

## Status legend

- ✓ **Shipped** — implementation complete; brief is reference-only.
- 🟡 **Partial** — some phases / slices shipped; explicit remainder open.
- ◯ **Deferred** — intentionally not started; documented dependency.
- ✗ **Not yet implemented** — open work.
- 📎 **Pointer** — points at a canonical doc elsewhere; not a build brief.
- 📋 **Reference** — operator deal-prep / strategic framing; no eng surface.

## Engineering briefs

| Brief | Status | Notes |
|---|---|---|
| `agent-gamification-and-market-probe-teams-brief.md` | ✓ Shipped | Per operator; Market Scout Phases 2A-2I include the agent layer. Verify if proposing slice-level work. |
| `apollo-integration-brief.md` | ✓ Shipped | 39 Apollo-related commits in `main`; org + people enrichment + autopilot integration live. |
| `assistant-tools-spec.md` | ✓ Shipped + extended | Per brief banner (2026-04-29) — reverse-search tools live; many tools added beyond spec. |
| `buyer-intelligence-v2-free-sources-brief.md` | ✓ Tier A complete | 5/5 Tier A sources shipped per CLAUDE.md (`fuel_consumption_signals`). Tier B/C deferred. |
| `caribbean-fuel-buyer-brief.md` | 🟡 Partial | Phase 1 foundation shipped (PRs #380/381/383, ~73/100-150 entities); Phases 2 (OCDS) + 3 (contacts) deferred. |
| `data-graph-connections-brief.md` | ✓ Shipped | Per operator. Items 1-5 closed via slate-fit + ownership + match-queue + vessel + customs surfaces. |
| `deal-structures-catalog-brief.md` | ✓ Shipped | PRs #386/#387/#388/#389 merged per brief banner. |
| `environmental-services-rolodex-brief.md` | ◯ Deferred | Adjacent capability; defer until Venezuela engagement crystallizes. No PRs against it. |
| `feedback-ui-brief.md` | ✓ Shipped | Patterns 1-5 + match queue + entity profile + `/pinned`/`/friction`/`/relationships/heat-map`/`/retrospectives` per CLAUDE.md (PRs #430-#435). LLM friction categorization gated on Trigger.dev v3→v4. |
| `gain-extraction-brief.md` | ✗ Not yet implemented | **NEW** as of 2026-05-11. USDA FAS GAIN narrative report extraction. 4-6 days. Companions: `fas-opendata-brief.md` (already shipped as PRs #634 + #636), `mirror-export-side-brief.md` (TBD). |
| `intelligence-layers-brief.md` | ✓ Shipped | All 3 layers (vessel/pricing/distress) live per brief banner. |
| `mcp-server-brief.md` | ✓ Shipped | Per operator; 18 MCP-related commits in `main`. |
| `pricing-analytics-brief.md` | ✓ Shipped + extended | Per brief banner; addendum at end of file documents follow-on work. |
| `procur-ml-layer-brief.md` | 🟡 Partial | Components A (vector store), B (GraphSAGE), D (attribute prediction + mention resolution) shipped per CLAUDE.md. **Component C (two-tower)** deferred — gated on ≥10K match-outcome labels. |
| `strategic-vision.md` | 📋 Reference | Per brief banner: "destination state substantially built." Strategic framing only. |
| `supplier-graph-brief.md` | ✓ Shipped | Per brief banner (2026-04-29). Migrations 0032/0033/0047 + indexes + tools live. |
| `vex-into-procur-merge-brief.md` | 🟡 Partial | Phase 0 locked (decisions doc); Phase 1+ TBD. Consult operator for current phase position before scoping new work. |

## Phase-gated follow-ups (Trigger.dev v3→v4)

Five items wait on a single upstream migration per CLAUDE.md:

- Apollo nightly cron
- ML Component B days 8-10 (scheduled GraphSAGE retraining)
- Website intelligence "refresh" admin button
- Friction-logging LLM auto-categorization
- Deal-retrospective 7-day delayed notification

Don't try to unblock these one at a time. Migrate Trigger.dev v3→v4 in
a dedicated PR; the five follow-ups slot in cleanly afterward.

## Operator deal-prep (not engineering work)

These are reference / engagement materials, not build briefs:

| File | Use |
|---|---|
| `libyan-crude-buyer-brief.md` | Operator engagement context |
| `venezuela-broker-meeting-prep.md` | Operator engagement context |
| `venezuela-contractor-intelligence.md` | Operator engagement context |
| `venezuela-counsel-briefing.md` | Operator engagement context |
| `venezuela-oilfield-waste-contractor-brief.md` | Operator engagement context |

## Pointers (canonical lives in `cjkootch/vex`)

Read for surface area procur owns; canonical brief lives in vex repo.

- `vex-commercial-strategy-pointer.md`
- `vex-integration.md`
- `vex-into-procur-merge-decisions.md` (locked Phase 0 decisions)
- `vex-merge-smoke-tests.md` (verification checklist consumed after merge phases)
- `vex-origination-partners-pointer.md`
- `vex-specialty-crude-30day-pointer.md`
- `vex-specialty-crude-pointer.md`
- `vex-tender-sourcing-pointer.md`

---

## How to update this file

When you ship work against a brief:

1. Flip its row's status (✗ → ✓, 🟡 → ✓, etc.).
2. Cite the PR(s) in the "Notes" column.
3. Bump the "Last refreshed" date at the top.

When you discover a status here is wrong: fix it here FIRST, then
optionally update the brief's own status line. This file is canonical.
