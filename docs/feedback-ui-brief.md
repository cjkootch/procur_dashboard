# Feedback UI: Capturing Signal Without Friction

**Status:** working brief, near-term implementation
**Owner:** Cole (procur and vex are Cole's personal IP)
**Last updated:** 2026-05-05
**Repos:** `cjkootch/procur_dashboard`, `cjkootch/vex`
**Implementation context:** This brief is consumed by Claude Code at the time of implementation. It specifies five feedback UI patterns to be added to procur and vex that capture user signal during normal usage rather than as separate tasks. The feedback data feeds into match-outcome learning (PR #309), entity attribute correction, friction prioritization, relationship pipeline tracking, and deal pattern accumulation.

---

## 1. What this brief is and isn't

This brief specifies five user-facing feedback patterns and the schema, UI components, and integration points needed to ship them. The goal is to convert procur and vex from systems that store data into systems that learn from usage — turning every interaction into a labeled training signal for downstream ML and prioritization decisions.

**It is not** a full feedback architecture redesign. The patterns build on existing schema (entities, signals, match-queue, dispositions where they exist) and add minimal new tables. No structural refactoring required.

**It is not** a research project. The five patterns reflect production-validated approaches from comparable systems (GitHub's reaction system, Linear's issue triage, Notion's inline editing, Superhuman's keyboard-first feedback). The brief specifies what to implement, not what to investigate.

**It is not** a usability research deliverable. The patterns assume Cole as primary user with sophisticated workflow expectations. They optimize for power-user feedback capture, not first-time user discovery. Adjust if user base broadens later.

---

## 2. Strategic context

The compounding value of procur and vex depends on feedback loops, not features. The infrastructure built through PRs #346-409 (procur) and #305-326 (vex) provides capability. Whether that capability translates to commercial leverage depends on whether usage produces structured signal that improves the system over time.

Five feedback loops matter most:

1. **Match-quality feedback** — was this surfaced match relevant? Drives match-queue learned ranking (per ML layer brief Component C).
2. **Entity attribute quality** — is this entity profile accurate? Drives data quality and provides labels for attribute prediction (per ML layer brief Component D).
3. **Friction logging** — what does the user wish the system would do? Drives prioritization for future development.
4. **Relationship disposition** — where does this commercial relationship actually stand? Converts the rolodex from directory into pipeline.
5. **Deal retrospectives** — what did this deal teach us? Builds the pattern library that makes future deal evaluation faster and sharper.

Without UI to capture these loops at low friction, the ML brief, the buyer intelligence v2 brief, and the broader commercial leverage of procur all underperform their potential. The single highest-leverage feedback pattern is match-quality feedback because it has the highest interaction frequency and feeds directly into the existing match-outcome feedback table from PR #309.

The principle that determines all five UI designs:

**Friction kills feedback loops.** Every additional click, decision, or moment of cognitive load between "user has reaction" and "feedback captured" drops capture rate exponentially. The patterns below are calibrated to capture feedback as a side effect of normal usage rather than as a separate task. Anything that feels like "now I need to give feedback" loses to anything that feels like "I'm just using the system."

---

## 3. Architecture decisions before implementation

Three decisions need to be made before any pattern ships:

### 3.1 Schema for unified feedback events

Rather than per-pattern tables, use a single `feedback_events` table that captures all five patterns. Pattern-specific data goes in a JSONB payload column.

```sql
CREATE TABLE feedback_events (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,           -- Clerk user id
    feedback_kind TEXT NOT NULL,     -- 'match_quality', 'entity_attribute', 'friction', 'disposition', 'retrospective'
    target_type TEXT,                -- 'match', 'entity', 'signal', 'deal', 'global'
    target_id TEXT,                  -- references the target object (entity_slug, match_id, deal_id, etc.)
    target_secondary_id TEXT,        -- for compound references (e.g., entity_slug + signal_source)
    sentiment TEXT,                  -- 'positive', 'negative', 'neutral', 'mute', 'pin', NULL
    payload JSONB NOT NULL DEFAULT '{}',  -- pattern-specific data
    context JSONB,                   -- captured context: page, recent action, etc.
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- soft-delete for "actually I didn't mean that" patterns
    revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_fbe_user ON feedback_events(user_id);
CREATE INDEX idx_fbe_kind ON feedback_events(feedback_kind);
CREATE INDEX idx_fbe_target ON feedback_events(target_type, target_id);
CREATE INDEX idx_fbe_created ON feedback_events(created_at DESC);
CREATE INDEX idx_fbe_payload ON feedback_events USING gin (payload);
```

Key design choices:
- **Single table for all feedback patterns.** Reduces schema complexity, simplifies analytics queries, makes cross-pattern feedback aggregation trivial. JSONB payload handles per-pattern variation.
- **Sentiment column extracted from payload for indexability.** Enables fast queries like "all negative feedback on this entity" without JSONB unpacking.
- **Context column captures situational data.** Page URL, recent search, recent navigation, current entity context. Enables retrospective analysis like "feedback patterns when users are evaluating new entities vs. reviewing existing relationships."
- **Revoked_at for soft-delete.** Users sometimes change their mind. Soft-delete preserves the original signal for audit while removing it from active feedback aggregation.
- **JSONB GIN index for payload queries.** Enables efficient filtering on pattern-specific fields without per-pattern indexes.

### 3.2 Existing match-outcome integration

PR #309 in vex shipped match-outcome feedback. That table exists and is populated by existing UI surfaces. The unified feedback_events approach should:
- **Continue writing to the existing match-outcome table** for backward compatibility with downstream consumers
- **Mirror the data into feedback_events.feedback_kind='match_quality'** for unified analytics
- **Avoid migrating the existing data** — let both tables co-exist; the unified view aggregates across both

This decision keeps PR #309's work intact while extending feedback capture to the four other patterns.

### 3.3 Keyboard shortcut conflicts

Both procur and vex have existing keyboard shortcuts (vex j/k navigation per PR #273). New feedback shortcuts must not conflict. Recommended assignments:

- `f` — positive feedback (mnemonic: "fave")
- `d` — negative feedback (mnemonic: "dismiss")
- `m` — mute signal type
- `p` — pin for follow-up
- `?` or `Ctrl+/` — open friction log
- `e` — edit current field (in entity profile context)

These are scoped to the active context. In match-queue context, `f`/`d` provide match feedback. In entity profile context, `e` opens inline edit. In any context, `?` opens friction log.

A discoverable help overlay (triggered by `Shift+?`) shows all active shortcuts.

---

## 4. Pattern 1 — Match-queue feedback (highest priority)

### 4.1 Use case

The match-queue surfaces signals to users continuously. Each surfaced match represents a system prediction: "this signal is relevant to your current goals." User reactions are the labels that make the prediction model better. Currently those labels are not consistently captured because feedback UI requires more clicks than the user is willing to invest.

### 4.2 UI specification

Each match in the queue displays as a row with always-visible feedback controls:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tecpetrol Servicios Ambientales                                      │
│ Customs filing: 12,400 MT bauxite waste handling, Argentina, Q1 2026│
│ via Bond prospectus | 2h ago | confidence: 0.85                     │
│                                                  👍  👎  🔇  📌       │
└─────────────────────────────────────────────────────────────────────┘
```

Feedback controls:
- 👍 thumbs-up — match was relevant, surfaces more like this
- 👎 thumbs-down — match was not relevant, surfaces less like this
- 🔇 mute — for this entity, suppress this signal type going forward
- 📌 pin — not acting now but flag for follow-up

Each control is a single click or single keystroke (`f`/`d`/`m`/`p`).

### 4.3 Critical interaction details

**Auto-advance on feedback action.** When user hits `f` or `d`, the next match auto-loads and gets focus. The user is in continuous triage flow, not "give feedback then navigate" flow. **This single design choice typically doubles feedback capture rate vs. systems that require manual navigation after feedback.**

**Soft visual confirmation, no popup.** When feedback is captured, a 200ms color flash on the match row confirms the action. No "thank you" message, no toast notification, no modal. The visual acknowledgment is necessary to prevent users from doubting their action; the absence of further interruption is necessary to preserve flow.

**Optional dismiss reason, with timeout.** When a user hits `d` (negative), an optional reason dropdown appears for 3 seconds with 4-5 preset reasons:
- Irrelevant entity
- Wrong segment
- Outdated information
- Duplicate of another match
- Other (free text, optional)

If the user clicks a reason within 3 seconds, the reason is logged. If they don't, the dismiss is logged without reason and the next match loads. The 3-second timeout is critical — it never blocks the user from continuing.

**Mute behavior is structural, not just instance-level.** When the user mutes, the system records a rule: "for entity X, suppress signals of type Y from source Z." Future matches matching that rule are suppressed. The mute applies until the user un-mutes (via entity settings) or the suppressed signal pattern changes meaningfully (signal recurrence after 90 days re-surfaces with a "previously muted" indicator).

**Pin creates a follow-up queue.** Pinned matches go to `/app/pinned` (or equivalent), a persistent list the user can review later. Pins age out after 30 days unless explicitly extended.

### 4.4 Schema mapping

For each match feedback action:

```sql
INSERT INTO feedback_events (
    user_id,
    feedback_kind,
    target_type,
    target_id,
    target_secondary_id,
    sentiment,
    payload,
    context
) VALUES (
    'user_xxx',
    'match_quality',
    'match',
    '{match_id}',
    '{entity_slug}',  -- secondary id ties feedback to entity, not just match
    'positive' | 'negative' | 'mute' | 'pin',
    jsonb_build_object(
        'match_score', 0.85,
        'signal_type', 'customs_filing',
        'signal_source', 'aduana_argentina',
        'dismiss_reason', 'wrong_segment'  -- only on dismiss with reason
    ),
    jsonb_build_object(
        'page', '/app/match-queue',
        'queue_position', 3,
        'session_match_count', 12
    )
);
```

For mute actions, additionally insert a row in a `signal_mute_rules` table:

```sql
CREATE TABLE signal_mute_rules (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_slug TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_source TEXT,
    muted_at TIMESTAMPTZ DEFAULT NOW(),
    muted_until TIMESTAMPTZ,  -- NULL = indefinite
    UNIQUE(user_id, entity_slug, signal_type, COALESCE(signal_source, ''))
);
```

### 4.5 Implementation effort

**1-2 days for working Pattern 1.**
- Day 1: UI components (match row with feedback icons, keyboard shortcut handlers, auto-advance logic, soft confirmation animation), feedback_events table migration if not already present
- Day 2: Mute rule table and signal suppression logic, pin queue page, dismiss reason dropdown with timeout, integration with existing match-outcome table

### 4.6 Anti-patterns to avoid

- Modal dialogs asking "rate this match 1-5 stars"
- Required reasons for any feedback action
- Confirmation popups ("are you sure you want to dismiss?")
- "Thank you for your feedback!" messages
- Animations that delay the next match from loading
- Feedback that only works via mouse (must be keyboard-accessible)

---

## 5. Pattern 2 — Entity attribute quality

### 5.1 Use case

Users frequently view entity profiles and notice errors or gaps — wrong segment classification, outdated operational scale, missing fuel type, incorrect HQ location. Most never report these because the friction of reporting is higher than the value of correction. The fix is making correction part of the viewing experience, not a separate task.

### 5.2 UI specification

Entity profile displays each attribute with a current value and confidence indicator:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Tecpetrol Servicios Ambientales                                      │
│ ───────────────────────────────                                      │
│                                                                       │
│ Segment:           Mining environmental services    🟢 ✏️             │
│ Sub-segment:       Drilling waste handling         🟡 ✏️             │
│ Operational scale: Large (1M+ MT/yr handled)       🟡 ✏️             │
│ HQ country:        Argentina                        🟢 ✏️             │
│ Operating regions: AR, BR, MX, CO                  🟢 ✏️             │
│ Primary fuel use:  Diesel (heavy equipment)        🟡 ✏️             │
│ Key contact:       [unknown]                        ⚪ ✏️             │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘

Confidence: 🟢 high | 🟡 medium | ⚪ unknown | 🔴 disputed
```

The pencil icon (✏️) appears on hover for editable fields. Click opens an inline editor with current value pre-populated:

```
Segment:           [ Mining environmental services    ▾ ] [✓] [✗]
                   Common values: Mining environmental services,
                                  Industrial waste handling,
                                  Oilfield environmental services,
                                  Other (specify)
```

Save with Enter or click ✓. Cancel with Esc or click ✗. The action takes 5-10 seconds end to end.

### 5.3 Critical interaction details

**Edits affect the entity globally, not just this user's view.** The user is correcting the system's data, not making personal annotations. This is explicit visually — saved changes show a "you corrected this" indicator that fades after 24 hours, and the new value is immediately reflected for all users.

**Confidence indicator is interactive.** Clicking a confidence indicator shows the source breakdown:
```
🟢 High confidence based on:
  • Bond prospectus (Tecpetrol 2025 Eurobond, p. 47)
  • CDP filing (Tecpetrol 2024 disclosure)
  • EITI Argentina report (2024)
  
Last validated: 2026-04-12
```

This transparency lets users decide whether to trust the existing value or override.

**Common values dropdown reduces typing.** For categorical fields (segment, country, etc.), the editor shows the most common values across the entity database. Selecting from common values is one click; typing a new value is also possible.

**Edit history visible per attribute.** Hover or right-click an attribute to see edit history: "Changed by Cole on 2026-05-05 from 'Industrial waste' to 'Mining environmental services.' Previous value 'Industrial waste' set on 2026-04-15 by Cole."

**Disputed values flagged distinctly.** When two users (or one user and the automated extraction) disagree on a value, the confidence indicator shows 🔴 (disputed) and clicking shows both values with their sources. The user can resolve by selecting the correct value, which logs the resolution as a feedback event.

### 5.4 Schema mapping

```sql
-- The actual entity update happens via the existing known_entities update path

-- Additionally, log the feedback event:
INSERT INTO feedback_events (
    user_id,
    feedback_kind,
    target_type,
    target_id,
    sentiment,
    payload,
    context
) VALUES (
    'user_xxx',
    'entity_attribute',
    'entity',
    '{entity_slug}',
    'neutral',  -- attribute corrections are signal but not sentiment
    jsonb_build_object(
        'attribute', 'segment',
        'old_value', 'Industrial waste',
        'new_value', 'Mining environmental services',
        'old_confidence', 0.65,
        'edit_type', 'correction'  -- 'correction', 'addition', 'removal'
    ),
    jsonb_build_object(
        'page', '/app/entity/{slug}',
        'time_on_page_seconds', 47
    )
);
```

These events become training labels for the attribute prediction model in ML layer Component D.

### 5.5 Implementation effort

**1-2 days for working Pattern 2.**
- Day 1: Inline editable field component, confidence indicator with click-to-expand, common values dropdown, edit history view
- Day 2: Disputed value resolution UI, feedback event logging, integration with existing entity update path

### 5.6 Anti-patterns to avoid

- "Submit a correction request" forms (feels like compliance, not collaboration)
- Modal dialogs for editing single attributes
- Required justification text for every edit
- Mass-edit interfaces that lose individual attribute granularity
- Hiding confidence indicators by default (users need to know what to trust)

---

## 6. Pattern 3 — Friction logging

### 6.1 Use case

Users encounter moments of friction during normal usage — they want the system to do something it can't, or to surface information it doesn't have. These moments are the highest-signal data for prioritizing future development. They're also nearly impossible to capture with traditional feedback mechanisms because users don't proactively switch context to file feedback.

The fix: make capture happen in the moment of frustration, with one click, with context auto-captured.

### 6.2 UI specification

A persistent floating button in the bottom-right corner of every procur and vex page:

```
                                                            ┌──────────┐
                                                            │ ❓ Stuck? │
                                                            └──────────┘
```

Or invoked by keyboard shortcut `?` or `Ctrl+/`.

Click or shortcut opens an inline overlay (not modal):

```
┌──────────────────────────────────────────────────────────┐
│ What did you wish the system would do?                   │
│                                                            │
│ [                                                       ] │
│ [                                                       ] │
│                                                            │
│ Context auto-captured:                                    │
│ • Viewing: entity "Tecpetrol Servicios Ambientales"       │
│ • Recent action: search "environmental services Argentina"│
│ • Recent navigation: /app/match-queue → /app/entity/tecpetrol│
│                                                            │
│                                       [Skip] [Save]       │
└──────────────────────────────────────────────────────────┘
```

The user types 1-3 sentences describing the friction. Total interaction time: 15-30 seconds.

### 6.3 Critical interaction details

**Auto-capture context aggressively.** The system pre-fills:
- Current page URL and page type
- Most recent search query (last 5 minutes)
- Most recent navigation path (last 3 pages)
- Currently viewed entity, deal, or other primary object
- Recent actions (matches viewed, signals dismissed, etc.)

The user only types the friction itself. Context elimination is what makes 15-second capture realistic.

**LLM categorization in background.** The user does not categorize their friction. After save, a background job uses Claude or GPT-4 to categorize:
- Friction type (missing data, missing capability, UI issue, performance, accuracy issue, workflow gap)
- Affected component (match queue, entity profile, search, integrations, etc.)
- Severity estimate (blocker, slowdown, nice-to-have)
- Suggested resolution path

The user never sees categorization UI. Categorization is for prioritization analytics only.

**Periodic friction queue surfacing.** Once a week, surface the user's own friction logs:

```
You logged 7 friction items this week. Status:
• "Need way to bulk-edit entity segments" — backlogged for v2
• "Search doesn't include Spanish-language terms" — in progress
• "Want to filter match queue by signal source" — shipped (try Ctrl+F)
• [4 more] [view all]
```

This closed-loop surfacing maintains the discipline. Users who don't see friction get acknowledged stop logging it.

**Skip is silent.** If the user opens the overlay and changes their mind, hitting Skip closes without logging anything. No "are you sure" prompts.

### 6.4 Schema mapping

```sql
INSERT INTO feedback_events (
    user_id,
    feedback_kind,
    target_type,
    target_id,
    sentiment,
    payload,
    context
) VALUES (
    'user_xxx',
    'friction',
    'global',  -- friction can be global or scoped
    NULL,      -- or current entity/deal/etc. if relevant
    'negative',
    jsonb_build_object(
        'description', 'I want to filter the match queue by signal source',
        'auto_category', 'missing_capability',  -- filled by LLM job
        'auto_severity', 'slowdown',
        'auto_component', 'match_queue',
        'auto_resolution_hint', 'add filter UI to /app/match-queue'
    ),
    jsonb_build_object(
        'page', '/app/match-queue',
        'recent_search', 'Tecpetrol customs filings',
        'navigation_path': ['/app', '/app/match-queue', '/app/entity/tecpetrol']
    )
);
```

A separate `friction_status` table tracks the lifecycle:

```sql
CREATE TABLE friction_status (
    feedback_event_id BIGINT PRIMARY KEY REFERENCES feedback_events(id),
    status TEXT NOT NULL DEFAULT 'logged',  -- 'logged', 'reviewing', 'in_progress', 'shipped', 'wontfix'
    resolution_note TEXT,
    resolved_at TIMESTAMPTZ,
    related_pr_url TEXT
);
```

### 6.5 Implementation effort

**1 day for working Pattern 3.**
- Floating button + keyboard shortcut handler
- Overlay UI with auto-context capture
- LLM categorization background job (Trigger.dev v3 — though noted dead in vex; substitute with serverless function)
- Friction queue page for periodic review
- Status lifecycle UI

### 6.6 Anti-patterns to avoid

- Intercom-style popups asking "having trouble?" (trains users to dismiss feedback prompts)
- Required categorization at capture time
- Ticket-tracker-style detailed forms
- Hiding the friction button (defeats the purpose)
- No closed-loop on friction status (kills the discipline within 30 days)

---

## 7. Pattern 4 — Disposition tracking

### 7.1 Use case

Every entity in the rolodex has a current commercial disposition: actively pursuing, dormant, dead lead, declined, never contacted. Most rolodex systems carry stale dispositions because users don't update them between interactions. The fix: integrate disposition updates into the natural workflows where users are already engaging with the entity.

### 7.2 UI specification

After any logged interaction with an entity (sent email, made call, attended meeting, sent document), a small contextual prompt appears:

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Logged call with Tecpetrol Servicios Ambientales       │
│                                                            │
│ Where does this relationship stand?                       │
│                                                            │
│ ○ Active — pursuing concrete opportunity                  │
│ ● Active — exploratory                                    │
│ ○ Dormant — paused, may revisit                           │
│ ○ Dead — no commercial path                                │
│ ○ Declined — for cause (note required)                    │
│                                                            │
│ Last set: 14 days ago     [Skip] [Save]                   │
└──────────────────────────────────────────────────────────┘
```

The current disposition is preselected. Save confirms in 5 seconds; change-then-save in 10 seconds; skip in instant.

### 7.3 Critical interaction details

**Stale disposition indicator.** When 30+ days pass since last disposition update, the disposition is shown with a stale indicator (⚠️) across all UI surfaces — entity profile, rolodex view, match queue context. This creates social pressure to keep dispositions fresh because stale data is visible whenever the user looks at the entity.

**Disposition heat-map view.** Dedicated page at `/app/relationships/heat-map`:

```
Active — pursuing (7)        Active — exploratory (12)     Dormant (23)
═══════════════════          ═══════════════════           ═════════
• Tecpetrol  (5d)            • SLB Latin Am  (2d)         • PluspetrolSrv (45d)⚠️
• Veolia     (1d)            • Halliburton  (12d)         • Newpark      (60d)⚠️
• ...                        • ...                          • ...

Dead (8)                     Declined (3)                  Never contacted (47)
═══════════                  ═══════════                   ═════════════════
• ...                        • ...                          • ...
```

This view lets the user see at a glance which relationships are stale and prompts batch updates without nagging.

**Declined requires reason.** Selecting "Declined — for cause" opens a small required text field. This is the one feedback type where required text is justified because declined relationships need a reason to prevent re-engagement and to inform future similar evaluations.

**Disposition history per entity.** Entity profile shows disposition timeline:
```
2026-05-05  Active — exploratory   (Cole, after broker call)
2026-04-21  Never contacted        (system default on entity creation)
```

### 7.4 Schema mapping

A dedicated dispositions table (separate from feedback_events because the current state is queried frequently):

```sql
CREATE TABLE entity_dispositions (
    id BIGSERIAL PRIMARY KEY,
    entity_slug TEXT NOT NULL REFERENCES known_entities(slug),
    user_id TEXT NOT NULL,
    disposition TEXT NOT NULL,  -- 'active_pursuing', 'active_exploratory', 'dormant', 'dead', 'declined', 'never_contacted'
    decline_reason TEXT,
    set_at TIMESTAMPTZ DEFAULT NOW(),
    set_by_interaction_id BIGINT,  -- references the interaction that triggered the prompt, if any
    superseded_at TIMESTAMPTZ,
    UNIQUE(entity_slug, user_id, set_at)
);

CREATE INDEX idx_disp_entity_current 
    ON entity_dispositions(entity_slug, user_id) 
    WHERE superseded_at IS NULL;

-- Convenience view for current dispositions
CREATE VIEW current_dispositions AS
SELECT DISTINCT ON (entity_slug, user_id)
    entity_slug, user_id, disposition, decline_reason, set_at
FROM entity_dispositions
WHERE superseded_at IS NULL
ORDER BY entity_slug, user_id, set_at DESC;
```

When disposition is updated, the previous record's `superseded_at` is set, preserving history.

A feedback event is also logged:

```sql
INSERT INTO feedback_events (
    user_id,
    feedback_kind,
    target_type,
    target_id,
    payload,
    context
) VALUES (
    'user_xxx',
    'disposition',
    'entity',
    '{entity_slug}',
    jsonb_build_object(
        'old_disposition', 'never_contacted',
        'new_disposition', 'active_exploratory',
        'triggering_interaction': 'call_log_id_12345'
    ),
    jsonb_build_object(
        'page', '/app/entity/{slug}',
        'prompt_source': 'post_interaction'
    )
);
```

### 7.5 Implementation effort

**1-2 days for working Pattern 4.**
- Day 1: Disposition table and history tracking, post-interaction prompt UI, stale indicator across surfaces
- Day 2: Heat-map view, disposition history per entity, declined-with-reason flow

### 7.6 Anti-patterns to avoid

- Required disposition updates on every interaction (users will reflexively click skip and data becomes worthless)
- Modal dialogs for disposition updates (overlay on the interaction confirmation is right; modal is too heavy)
- More than 5-6 disposition options (more than this and users default to one option)
- Hiding stale data (kills the discipline; staleness must be visible)

---

## 8. Pattern 5 — Deal retrospectives

### 8.1 Use case

Deal retrospectives are the highest-value feedback type but the easiest to skip because they happen after deal energy has dissipated. Most operators carry deal lessons in their head, where they're forgotten within months and unavailable to AI/system-assisted analysis of similar future deals. The fix: structured retrospectives triggered automatically at deal closure, surfaced contextually during similar future deals.

### 8.2 UI specification

When a deal in vex moves to "won," "lost," or "dead" status, an automatic retrospective is queued. 7 days later, the user sees a notification:

```
┌──────────────────────────────────────────────────────────┐
│ Retrospective: Caribbean Diesel Q4 Tender (won)          │
│ ───────────────────────────────                          │
│                                                            │
│ This deal closed 7 days ago. A 5-minute retrospective    │
│ now will help the system learn from it.                  │
│                                                            │
│  [Start Retrospective]  [Snooze 3 days]  [Skip permanently]│
└──────────────────────────────────────────────────────────┘
```

Click Start opens a structured form:

```
┌──────────────────────────────────────────────────────────┐
│ Retrospective: Caribbean Diesel Q4 Tender (won)          │
│ ─────────────────────────────────────────                │
│                                                            │
│ What signal first surfaced this opportunity?              │
│ ○ Procur match-queue   ○ Direct counterparty conversation │
│ ○ Broker introduction  ○ News/media coverage              │
│ ○ Other: [______________]                                  │
│                                                            │
│ How long from first signal to deal closure?               │
│ [   ] days                                                  │
│                                                            │
│ What were the 1-2 critical moments that determined the    │
│ outcome?                                                   │
│ [                                                       ]  │
│ [                                                       ]  │
│                                                            │
│ Did procur surface any insight that mattered to the       │
│ outcome?                                                   │
│ ○ Yes, materially  ○ Yes, marginally  ○ No  ○ N/A         │
│                                                            │
│ What would have made this deal close faster or with       │
│ better economics?                                          │
│ [                                                       ]  │
│ [                                                       ]  │
│                                                            │
│ What pattern from this deal should we apply to similar    │
│ future deals?                                              │
│ [                                                       ]  │
│ [                                                       ]  │
│                                                            │
│ [Save Retrospective]  [Save Draft]                        │
└──────────────────────────────────────────────────────────┘
```

Total time: 5-7 minutes for a thoughtful retrospective.

### 8.3 Critical interaction details

**7-day delay is deliberate.** The day a deal closes, the user is exhausted, the data is worse, and capture rate is low. 7 days later, the energy has reset and reflection produces sharper signal.

**Retrospective surfacing during similar deals.** When the user encounters a similar deal in the future (same buyer segment, same geography, similar structure, same broker), the system surfaces relevant past retrospectives:

```
┌──────────────────────────────────────────────────────────┐
│ ℹ️ Similar past deal detected                              │
│                                                            │
│ You ran "Caribbean Diesel Q4 Tender" 8 months ago,        │
│ similar buyer segment and geography.                      │
│                                                            │
│ Key lesson recorded:                                      │
│ "Mixta-side procurement timeline was 3x longer than       │
│ broker estimated. Build counsel review buffer into        │
│ commercial timeline."                                      │
│                                                            │
│ [View full retrospective] [Dismiss]                       │
└──────────────────────────────────────────────────────────┘
```

This is where retrospectives produce compounding value, and it's the UI element that justifies the time investment in writing them.

**Save Draft for unfinished retrospectives.** If the user can't complete in one sitting, saving as draft lets them resume later without losing partial input. Drafts are surfaced with the original 7-day reminder.

**Skip permanently is real.** Some deals don't merit retrospectives (rejected at evaluation stage, dead within 24 hours, etc.). The skip option is genuine, not a soft no — it removes the retrospective from the queue and never re-prompts.

### 8.4 Schema mapping

```sql
CREATE TABLE deal_retrospectives (
    id BIGSERIAL PRIMARY KEY,
    deal_id BIGINT NOT NULL,  -- references the deal in vex
    user_id TEXT NOT NULL,
    deal_outcome TEXT NOT NULL,  -- 'won', 'lost', 'dead'
    initial_signal_source TEXT,
    days_signal_to_close INTEGER,
    critical_moments TEXT,
    procur_insight_mattered TEXT,  -- 'yes_materially', 'yes_marginally', 'no', 'na'
    what_would_have_helped TEXT,
    pattern_for_future TEXT,
    completed_at TIMESTAMPTZ,
    is_draft BOOLEAN DEFAULT FALSE,
    UNIQUE(deal_id, user_id)
);

-- Retrospective surfacing query uses entity, segment, and structure similarity
-- against ML layer Component A embeddings (when available) or attribute matching (before)
```

A feedback event is logged on completion:

```sql
INSERT INTO feedback_events (
    user_id,
    feedback_kind,
    target_type,
    target_id,
    payload
) VALUES (
    'user_xxx',
    'retrospective',
    'deal',
    '{deal_id}',
    jsonb_build_object(
        'deal_outcome', 'won',
        'procur_insight_mattered', 'yes_materially',
        'pattern_for_future', '...'
    )
);
```

### 8.5 Implementation effort

**2-3 days for working Pattern 5.**
- Day 1: Schema, retrospective form UI, draft save support
- Day 2: 7-day delayed notification system, retrospective queue page
- Day 3: Similar-deal detection and retrospective surfacing (uses attribute matching pre-ML, ML similarity post-ML), integration with deal closure events in vex

### 8.6 Anti-patterns to avoid

- Asking for retrospectives the day the deal closes
- Free-text-only forms (structured fields produce more usable data)
- Required retrospectives (kills user trust; some deals shouldn't be retrospected)
- Retrospectives that aren't surfaced during similar future deals (eliminates the compounding payoff)
- Mandatory minimum text length (forces filler when the lesson is genuinely brief)

---

## 9. Cross-cutting design principles

These apply to all five patterns:

**Feedback should never block the primary task.** Every feedback UI element has to be skippable. The capture rate target is "easy enough that 80% of users do it 80% of the time," not "force 100% capture."

**Acknowledge but don't celebrate.** Small visual confirmation that feedback was captured is necessary. Confetti animations, "thank you for your feedback!" messages, or any gamification feels patronizing. The user isn't doing the system a favor; they're using the system.

**Show the impact of feedback eventually.** Once a month, a notification: "Based on your feedback over the past 30 days, the match-queue surfaces 23% more deals you act on." This closes the loop and sustains discipline. Users who don't see impact stop providing feedback.

**Default to keyboard for power users.** Every feedback action accessible by keyboard shortcut. Power users (Cole, primarily) move faster with keys than mouse. A discoverable help overlay (`Shift+?` to show all shortcuts) prevents the feature from being hidden.

**Aggregate feedback respectfully.** When multiple users provide conflicting feedback, don't surface the conflict in the UI. Resolve via confidence and recency in display; capture all signals in storage for ML training.

**Context is captured automatically, not requested.** Users should never have to explain "I was on this page when this happened." The system knows.

---

## 10. Implementation sequencing

If the patterns ship in priority order:

**Phase 1 (Days 1-2): Pattern 1 — Match-queue feedback.** Highest frequency, simplest implementation, most immediate compounding effect. Generates training data for ML layer Component C. Foundation for the rest.

**Phase 2 (Days 3-4): Pattern 2 — Entity attribute quality.** Medium frequency, moderate implementation. Generates training data for ML layer Component D. Improves data quality the buyer intelligence v2 brief depends on.

**Phase 3 (Day 5): Pattern 3 — Friction logging.** Low frequency but highest signal for prioritizing future development.

**Phase 4 (Days 6-7): Pattern 4 — Disposition tracking.** Medium frequency, integrates into existing workflow. Converts rolodex into pipeline.

**Phase 5 (Days 8-10): Pattern 5 — Deal retrospectives.** Lowest frequency, highest long-term compounding value, most complex UI. Most valuable when ML layer Component A enables similarity-based retrospective surfacing.

**Total: 6-10 days for full feedback UI suite.**

If shipping incrementally without the full suite: **Pattern 1 alone is the minimum viable feedback investment.** It's the foundation everything else builds on, has the highest interaction frequency, and produces immediately visible match-queue improvement once data accumulates. Two days of focused work for Pattern 1 produces more compounding value than seven days spread across all five patterns done partially.

---

## 11. Architecture decisions deferred to implementation time

These choices should be made when implementation starts, not in advance:

**Existing UI framework integration.** Procur and vex use Next.js + shadcn/ui. The feedback components should match existing design system. Specific component libraries (e.g., for the heat-map view) chosen at implementation.

**Notification mechanism.** Web push, in-app notification, email digest, or combination. Depends on what's already wired in vex. Default to in-app notification + optional email; add push if user demand emerges.

**LLM categorization model and prompt.** Claude Sonnet 4.6 or GPT-4 are both adequate. Specific prompt engineering for friction categorization is implementation-time work, not architecture-time.

**Mute rule expiration policy.** Indefinite vs. time-limited (90 days, 6 months, etc.). Start with indefinite; revisit if mutes accumulate to the point where users forget what they muted.

**Retrospective similarity threshold.** What similarity score qualifies a past deal as "similar enough" to surface? Start with 0.75 cosine similarity (when ML layer ships); pre-ML, use attribute match score. Tune based on user feedback on surfacing relevance.

**Edit history retention.** Keep all attribute edit history indefinitely vs. compact after 1 year. Start indefinite; revisit if storage becomes meaningful.

---

## 12. What this brief deliberately doesn't include

- Multi-user collaboration UI (procur and vex are primarily single-user; collaboration is a v2 concern)
- Bulk feedback operations (batch entity edits, etc.) — out of scope for v1, may be a v2 friction discovery
- Offline feedback capture — assumes online-only usage
- Mobile-specific UI patterns — desktop-first; mobile is responsive but not optimized
- Analytics dashboards on feedback patterns — out of scope; analytics builds on the schema once data accumulates
- ML feedback consumer pipelines — addressed in ML layer brief, not here
- A/B testing infrastructure for feedback UI variants — defer until usage justifies experimentation

---

## 13. Discipline notes for implementation

When this brief gets executed, three reminders:

**(1) Pattern 1 ships first or nothing else ships.** The other patterns depend on the same `feedback_events` table and architectural patterns established by Pattern 1. Skipping Pattern 1 to ship Pattern 5 (or any other) creates schema fragmentation and feedback event inconsistency.

**(2) Resist scope creep on individual patterns.** Each pattern has a deliberate minimum implementation. Adding "while we're in here, let's also build [feature]" extends each pattern from days to weeks and delays the compounding effect.

**(3) Validate the feedback discipline before assuming the data is good.** After 30 days of feedback collection, manually audit a sample of 50 feedback events to verify they capture useful signal. If feedback is dominated by reflex clicks (`f` everything in match queue, skip everything in retrospectives), the UI needs adjustment. The schema is good; the discipline depends on UI calibration.

---

End of brief.
