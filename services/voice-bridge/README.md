# `@procur/voice-bridge`

Long-lived WebSocket service that bridges Twilio Media Streams ↔ OpenAI Realtime API. Powers the AI-talkback voice mode (`outbound_call` action with `aiMode=true`) per docs/vex-into-procur-merge-brief.md Phase 7.5.

## Why a separate service

Vercel Functions can't host long-lived WebSocket connections. Twilio's Media Streams protocol opens a WSS connection mid-call and streams audio frames bidirectionally for the call's duration (potentially many minutes). This service runs on Fly so the WebSocket can stay open.

## Routes

| Method | Path             | Purpose |
|--------|------------------|---------|
| `GET`  | `/health`        | Liveness check (Fly health-check target) |
| `WSS`  | `/twilio-stream` | Twilio Media Streams entry point |

When procur's TwiML route receives a call with `?mode=ai`, it returns:

```xml
<Connect>
  <Stream url="wss://procur-voice-bridge.fly.dev/twilio-stream">
    <Parameter name="approvalId" value="01HW…"/>
    <Parameter name="aiInstructions" value="Confirm BL timing on deal 003…"/>
    <Parameter name="goalHint" value="…"/>
  </Stream>
</Connect>
```

Twilio strips query strings from `<Stream url=>`, so per-call params ride on `<Parameter>` children — the bridge reads them off the `start` event.

## Audio path

- Both Twilio Media Streams and OpenAI Realtime speak G.711 μ-law @ 8kHz natively. **No resampling** — the bridge just shuttles base64-encoded frames.
- Twilio frames arrive at ~50/sec (one per 20ms). The bridge forwards each as `input_audio_buffer.append` to OpenAI.
- OpenAI's `response.audio.delta` events carry assistant audio frames. The bridge wraps each in `{ event: 'media', streamSid, media: { payload } }` and ships back to Twilio.

## Cost ledger

Single `cost_ledger` row per call on disconnect, idempotent on `voice_bridge:${streamSid}`. v1 stub at $0.30/min combined; refine once OpenAI publishes per-token breakdown via the API.

## Deploy (uses Cole's existing Fly account)

```sh
cd services/voice-bridge

# First-time:
fly launch --name procur-voice-bridge --no-deploy --copy-config

# Set secrets (one-time):
fly secrets set -a procur-voice-bridge \
  OPENAI_API_KEY=sk-… \
  DATABASE_URL=postgresql://…  # same Neon URL the main app uses

# Deploy:
fly deploy --remote-only
```

## Procur env vars (set on the apps/app Vercel project)

- `VOICE_BRIDGE_WSS_URL` (optional) — defaults to `wss://procur-voice-bridge.fly.dev/twilio-stream`. Override for staging.

## Verification (post-deploy)

1. `curl https://procur-voice-bridge.fly.dev/health` → `{"ok":true,…}`
2. From the chat: "have Vex call <contact>" with `aiMode=true` → approval lands → approve → Twilio dials → caller hears the AI assistant.
3. Confirm `cost_ledger` row at the end of the call.

## Tearing down vex

After Phase 7.5 stabilizes:
```sh
fly apps destroy vex-api -y
```

(All procur code that talked to vex was deleted in Phase 4 + 6.)
