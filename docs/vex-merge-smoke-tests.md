# Vex-into-procur merge — smoke test plan

End-to-end paste-ready prompts to verify each phase of the merge is wired correctly. Run these in procur's chat assistant **after** the env vars in `docs/vex-into-procur-merge-decisions.md` are set in Vercel + the voice-bridge is deployed to Fly.

## Prerequisites

- Vercel envs set: `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER=+18775494685`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TRADE_GOV_CSL_API_KEY`, `RESEND_INBOUND_WEBHOOK_SECRET`, `RESEND_API_KEY`
- Fly app `procur-voice-bridge` deployed with `OPENAI_API_KEY` + `DATABASE_URL` secrets
- DNS for `links.vectortradecapital.com` shows ✅ on Resend (SPF + MX + DKIM all green)
- Twilio Messaging Service inbound URL points at `https://app.procur.app/api/webhooks/twilio?kind=inbound-sms`
- Twilio voice TwiML App URL points at `https://app.procur.app/api/webhooks/twilio/twiml`

## Smoke test 1 — propose + approve email (Phase 3 + 7.6)

**Chat:**
> Email cole+test@vectortradecapital.com with subject "Procur smoke test" and body "If you can read this, the merge works." Rationale: verify Phase 3 wiring.

**Expected:**
1. Assistant calls `propose_email_send`, returns chip linking to `/approvals/<id>`
2. Open `/approvals/<id>` — payload shows the email shape
3. Click Approve — Resend dispatches the email
4. Email arrives at the inbox within 30s
5. `/calls` (or wherever email touchpoints surface) — wait, that's `/inbox` — shows an `email.sent` touchpoint
6. `/agent-runs` shows zero new runs (chat tool, not agent)
7. cost_ledger has one entry per recipient (email.send / resend / 1 emails / $0.0001)

## Smoke test 2 — sanctions screen (Phase 6)

**Chat:**
> Screen the organization with id 01HW0123456789ABCDEFGHIJKL (replace with a real organization id from `/organizations` or via lookup_known_entities) — see if Rosneft hits OFAC. Rationale: smoke test Phase 6.

**Expected:**
1. Assistant calls `propose_sanctions_screen`, returns chip
2. Approve at `/approvals/<id>`
3. SanctionsScreeningAgent fires (visible at `/agent-runs`)
4. `/signals` shows a critical row for Rosneft (or the org you screened — Rosneft will hit, Vitol will be clean)
5. The org's profile shows updated `ofac_status` (`confirmed_match` or `clear`)

## Smoke test 3 — outbound call, conference mode (Phase 7)

**Chat:**
> Call my phone (+1XXXYYYZZZZ) for contact id <ulid> at org <ulid>. Goal: smoke test outbound voice. Conference mode (no AI).

**Expected:**
1. Assistant calls `propose_outbound_call` with `aiMode=false`
2. Approve at `/approvals/<id>`
3. Phone rings; pick up; hear "Please hold while we connect you to a team member" then conference music
4. Status callbacks land in `events` table (visible via `/calls` timeline)
5. cost_ledger entry: pstn.call / twilio / 1 calls / $0

## Smoke test 4 — outbound call, AI mode (Phase 7.5)

**Chat:**
> Call my phone (+1XXXYYYZZZZ) for contact id <ulid> at org <ulid> in AI mode. The AI should ask me about a hypothetical fuel order quantity. Rationale: smoke test the voice-bridge.

**Expected:**
1. Assistant calls `propose_outbound_call` with `aiMode=true`
2. Approve at `/approvals/<id>`
3. Phone rings; pick up; the AI assistant speaks (OpenAI Realtime via the Fly bridge)
4. Have a brief conversation, then hang up
5. `procur-voice-bridge.fly.dev` logs show the bridge opened, frames flowed, and closed cleanly
6. cost_ledger entry: llm.voice / openai.realtime / N seconds / $X (proportional to call duration)

## Smoke test 5 — inbound email round-trip (Phase 3)

**Manual:**
> Send a test email from your personal address (e.g. cole@vectortradecapital.com) to a recipient address served by `links.vectortradecapital.com` (e.g. `test@links.vectortradecapital.com`).

**Expected:**
1. Resend's webhook fires `email.received` to `https://app.procur.app/api/webhooks/resend-inbound`
2. `/inbox` shows a new thread
3. Click into the thread — message body visible
4. Click "Draft reply" — the EmailReplyDraftAgent fires (visible at `/agent-runs`)
5. The agent's `email.send` proposal lands at `/approvals`
6. Approve → Resend sends; the recipient sees it

## Smoke test 6 — qualify-as-lead (Phase 4)

**Chat:**
> Qualify Reficar as a lead. They're a Colombian refinery looking for ULSD. Rationale: smoke test the qualify path.

OR via the `/entities/<slug>` page, click the "Qualify as lead" button.

**Expected:**
1. The `qualifyAsLead` flow fires (in-process; no approval needed since this isn't an ActionDescriptor — it's a chat-tool apply or button click)
2. New row in `leads` table
3. New row in `organizations` (if not already there)
4. `/leads/<id>` renders the procur metadata (push reason, signals, market context)

## Smoke test 7 — daily brief (Phase 6)

**Navigate** to `/brief`. If empty, click "Refresh".

**Expected:**
1. DailyBriefAgent fires (visible at `/agent-runs`)
2. `/brief` shows greeting + recommended-focus sentence
3. Stat cards reflect current state (pending approvals, signals, stale leads, active deals)
4. Top approvals + signals + risky deals lists populate

## Smoke test 8 — deal evaluator (Phase 5)

**Pre-req:** Create a fuel deal via chat (`propose_create_deal`) — that gives you a real deal id with a cost stack to evaluate.

**Chat (after deal exists):**
> Evaluate deal id <ulid>. Rationale: smoke test Phase 5.

This currently doesn't have a propose tool — the DealEvaluatorAgent runs via direct invocation. Add a propose-evaluate tool in a follow-up if you want chat-driven evaluation.

For now, you can verify:
1. The deal exists at `/deals/<id>`
2. The cost stack + scenario data are populated
3. The calculator's pure-function output is correct (run a unit test)

## Cost ledger sanity check

After running all the smokes, navigate to `/agent-runs`. Today's cost should be $0.10–$1.00 depending on test 4's call duration.

## When something goes wrong

- **Webhook 401**: signature secret mismatch. Re-copy from the provider's dashboard.
- **Webhook 404**: route URL typo. Check exact path including `?kind=` query param.
- **OpenAI 401 in voice-bridge**: `OPENAI_API_KEY` not set on Fly. `fly secrets set -a procur-voice-bridge OPENAI_API_KEY=…`.
- **Twilio 401 outbound**: `TWILIO_AUTH_TOKEN` or `TWILIO_API_KEY/SECRET` not set or wrong account. Twilio console → API keys → verify.
- **CSL 404**: `TRADE_GOV_CSL_API_KEY` set but pointing at the old `api.trade.gov/static/...` endpoint. Phase 6 fix PR #461 moved to the new `data.trade.gov/v1/search` with header auth — verify procur is on main.
- **Approval stuck pending**: executor failed silently. Check Vercel logs for the `/api/approvals/[id]/approve/route.ts` server action.

## Tear down vex (after all smokes pass)

```sh
fly apps destroy vex-api -y

# In Vercel envs, remove:
#   VEX_API_TOKEN
#   VEX_API_BASE_URL
#   PROCUR_API_TOKEN
```
