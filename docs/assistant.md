# Procur Assistant

A cross-product AI agent that reads from and (with user confirmation) writes
to a company's own data. Accessed at `/assistant` or via the global Cmd+K
launcher mounted in the app root layout.

## Architecture

```
apps/app
├── app/
│   ├── api/assistant/
│   │   ├── stream/route.ts         SSE endpoint (new agent turn)
│   │   ├── apply/route.ts          POST: execute a proposed write
│   │   └── threads/...             Thread list / get / rename / delete
│   ├── assistant/
│   │   ├── page.tsx                Thread list + empty chat
│   │   └── [threadId]/page.tsx     One thread, resumable
│   └── layout.tsx                  Mounts <AssistantDrawerMount/>
├── components/assistant/
│   ├── Chat.tsx                    Streaming client component
│   ├── AssistantDrawer.tsx         Cmd+K right-side drawer
│   ├── AssistantDrawerMount.tsx    Server gate on auth
│   ├── ThreadListItem.tsx          Rename / delete controls
│   └── types.ts
└── lib/assistant/
    ├── context.ts                  resolveAssistantContext (Clerk → ctx)
    ├── registry.ts                 Combined read + write tool registry
    ├── threads.ts                  Persistence helpers
    ├── apply.ts                    Write dispatcher + audit logging
    ├── proposals.ts                Shared Proposal shape
    └── tools/
        ├── get-*.ts / list-*.ts    Read tools
        ├── search-*.ts             Read tools (keyword + semantic)
        └── propose-*.ts            Write tools (return Proposal)

packages/ai/src/assistant/
├── loop.ts                         runAgentTurn (non-streaming)
├── stream.ts                       streamAgentTurn (async generator)
├── system-prompt.ts                Cached-static + per-turn context
├── tools/registry.ts               defineTool, zod → JSON-schema
├── budget.ts                       Monthly caps per plan tier
├── pricing.ts                      USD-per-MTok math
├── meter.ts                        Record usage for non-assistant AI calls
└── types.ts                        AssistantContext, ToolDefinition
```

## Invariants

1. **The agent never receives `companyId` or `userId`.** These are always
   server-derived from the Clerk session via `resolveAssistantContext()`.
2. **Write tools never mutate.** They return a `Proposal` the UI renders
   as a confirmation card. The user's Apply click POSTs to
   `/api/assistant/apply`, which dispatches to the matching handler.
3. **Every write is audited.** `apply.ts` writes an `auditLog` row tagged
   `assistant.<toolName>` for every Apply, success or failure.
4. **Budget is checked pre-flight.** `runAgentTurn` / `streamAgentTurn`
   both call `getBudgetStatus` before the first model call and throw
   `BudgetExceededError` if the company is over the monthly cap.
5. **Usage is always recorded.** Every model call records a row in
   `ai_usage` keyed on (company, date, source). This is the one table
   the budget UI reads from.

## Model routing

- **Agent loop**: `claude-sonnet-4-6` with `tools: [...]`. `max_tokens: 4096`.
- **Embeddings** (for `search_content_library`, `search_past_performance`):
  `text-embedding-3-small`.
- All other AI tasks keep the models they had pre-assistant
  (Haiku for classify/summarize/detect/translate/chunk; Sonnet for
  extraction/drafting/review).

## Budget caps

| Tier       | Monthly AI cap |
| ---------- | -------------- |
| free       | $5             |
| pro        | $25            |
| team       | $75            |
| enterprise | unlimited      |

Defined in `packages/ai/src/assistant/budget.ts`. Adjust in one place.

## Tool catalog (v1)

### Read (11)

| Tool                              | Purpose                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `get_company_profile`             | Company settings + declared capabilities                        |
| `get_home_summary`                | Counts, deadlines, drafting proposals, wins, obligations        |
| `list_pursuits`                   | Stage + overdue filters                                         |
| `get_pursuit`                     | Full pursuit detail + tasks                                     |
| `get_proposal`                    | Outline + section statuses + compliance summary (no bodies)     |
| `list_contracts`                  | Status filter                                                   |
| `list_recommended_opportunities`  | Match on capabilities / preferred categories / jurisdictions    |
| `search_opportunities`            | Cross-market active opp search (public scope)                   |
| `global_search`                   | Blended keyword + semantic across all modules                   |
| `search_content_library`          | Semantic retrieval over library entries                         |
| `search_past_performance`         | Semantic retrieval over past projects                           |

### Write — propose-then-apply (5)

| Tool                                | What the Apply does                                      |
| ----------------------------------- | -------------------------------------------------------- |
| `propose_create_pursuit`            | Insert pursuit (identification stage, assigned to user)  |
| `propose_advance_stage`             | Update stage; stamps submittedAt/wonAt/lostAt as needed  |
| `propose_create_task`               | Insert pursuit_tasks row                                 |
| `propose_draft_proposal_section`    | Run the full draftSection AI pipeline + update proposal  |
| `propose_create_alert_profile`     | Insert alert_profiles row for the current user           |

## Adding a new tool

1. Create `apps/app/lib/assistant/tools/<name>.ts` exporting a
   `defineTool({ name, description, kind, schema, handler })`.
2. Register it in `apps/app/lib/assistant/registry.ts` under the
   correct map (`readTools` or `writeTools`).
3. For write tools, add a case to `HANDLERS` in
   `apps/app/lib/assistant/apply.ts` that performs the real mutation.
4. Keep the description explicit about when to use it and what it
   returns — the model picks tools on description alone.
5. If the tool calls an LLM internally, wrap with `meter()` so its
   spend counts against the company's monthly cap.

## Threading model

- Messages persist in `assistant_messages` with `role ∈ { user, assistant, tool }`.
- `content` is a JSONB array of Anthropic content blocks, preserving
  `tool_use` blocks on assistant turns and `tool_result` blocks on
  their own `tool` rows.
- `messagesToHistory()` in `apps/app/lib/assistant/threads.ts`
  rebuilds `Anthropic.MessageParam[]` for replaying a thread on the
  next turn.

## Known limitations (v1)

- No voice or image input.
- No scheduled / autonomous runs — only user-initiated turns.
- No thread search; sidebar is ordered by `last_message_at DESC`.
- Apply is fire-and-forget; no confirmation of persisted results
  beyond the returned `redirectTo`.
- `propose_draft_proposal_section` runs synchronously during Apply —
  for long drafts this can take 5-15s; move to a Trigger.dev job if
  this becomes a complaint.
