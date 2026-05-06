import WebSocket from 'ws';
import type { FastifyBaseLogger } from 'fastify';
// Subpath import (not the barrel). The `@procur/ai` index re-exports
// `threads.ts`, which `import 's "server-only"` — a Next.js sentinel
// package that throws at import time outside an RSC bundler. The
// voice-bridge runs as plain Node on Fly, so pulling the barrel
// crashes the process at startup with ERR_MODULE_NOT_FOUND.
import { PostgresCostLedger } from '@procur/ai/cost-ledger';

/**
 * Per-call bridge between Twilio Media Streams (G.711 μ-law @ 8kHz)
 * and OpenAI Realtime API. Both speak G.711 μ-law natively, so no
 * audio resampling is needed — the bridge just shuttles base64-
 * encoded frames between the two WebSockets.
 *
 * Twilio's Media Streams protocol (one frame per ~20ms):
 *   { event: 'connected' | 'start' | 'media' | 'stop' | 'mark', … }
 *
 * OpenAI Realtime events the bridge cares about:
 *   inbound:  session.created, response.audio.delta, response.done,
 *             input_audio_buffer.speech_started/_stopped
 *   outbound: session.update, input_audio_buffer.append,
 *             input_audio_buffer.commit, response.create
 *
 * Per-call cost: OpenAI Realtime bills per token of audio (input +
 * output, separate rates). The bridge tallies duration and writes
 * a single cost_ledger entry on call end with idempotency key
 * `voice_bridge:${streamSid}`.
 */

const REALTIME_URL =
  process.env.OPENAI_REALTIME_URL ??
  'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DEFAULT_SYSTEM_PROMPT = `You are a polite, concise voice assistant
representing Procur, an AI-native fuel/food trading desk. Keep replies
short — typically one sentence. Confirm understanding, ask a single
focused question, or take a single next step. If the caller wants to
end the conversation, thank them and say goodbye.`;

interface TwilioStartPayload {
  streamSid: string;
  callSid: string;
  customParameters?: Record<string, string>;
}

interface BridgeStats {
  startedAt: Date | null;
  endedAt: Date | null;
  framesFromTwilio: number;
  framesToTwilio: number;
  systemPrompt: string;
}

const costLedger = new PostgresCostLedger();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleTwilioStream(
  twilioSocket: any,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!OPENAI_API_KEY) {
    log.error('OPENAI_API_KEY not configured; closing bridge');
    twilioSocket.close();
    return;
  }

  const stats: BridgeStats = {
    startedAt: null,
    endedAt: null,
    framesFromTwilio: 0,
    framesToTwilio: 0,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let approvalId: string | null = null;
  let openaiReady = false;

  const openaiSocket = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  openaiSocket.on('open', () => {
    log.info('openai realtime ws open');
  });

  openaiSocket.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let event: { type?: string; delta?: string; [k: string]: unknown };
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (event.type === 'session.created') {
      // Session is up — push our system prompt + audio config.
      openaiSocket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: stats.systemPrompt,
            voice: 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: { type: 'server_vad' },
          },
        }),
      );
      openaiReady = true;
    }
    if (event.type === 'response.audio.delta' && typeof event.delta === 'string' && streamSid) {
      // Forward audio frames back to Twilio. Twilio expects
      // base64-encoded μ-law in `media.payload`.
      twilioSocket.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: event.delta },
        }),
      );
      stats.framesToTwilio += 1;
    }
    if (event.type === 'response.done') {
      // No-op; Twilio will keep streaming until the user hangs up.
    }
    if (event.type === 'error') {
      log.error({ event }, 'openai realtime error');
    }
  });

  openaiSocket.on('close', (code, reason) => {
    log.info(
      { code, reason: reason.toString() },
      'openai realtime ws closed',
    );
    try {
      twilioSocket.close();
    } catch {
      // ignore
    }
  });

  openaiSocket.on('error', (err) => {
    log.error({ err }, 'openai realtime ws error');
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  twilioSocket.on('message', (raw: any) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    let event: {
      event?: string;
      streamSid?: string;
      start?: TwilioStartPayload;
      media?: { payload?: string; track?: string };
      mark?: { name?: string };
    };
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (event.event === 'connected') {
      log.info('twilio media stream connected');
    }
    if (event.event === 'start' && event.start) {
      streamSid = event.start.streamSid;
      callSid = event.start.callSid;
      stats.startedAt = new Date();
      const params = event.start.customParameters ?? {};
      if (typeof params['approvalId'] === 'string') {
        approvalId = params['approvalId'];
      }
      if (typeof params['aiInstructions'] === 'string' && params['aiInstructions'].length > 0) {
        stats.systemPrompt = params['aiInstructions'];
      }
      log.info(
        { streamSid, callSid, approvalId },
        'twilio media stream started',
      );
    }
    if (event.event === 'media' && event.media?.payload) {
      stats.framesFromTwilio += 1;
      if (openaiReady) {
        openaiSocket.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: event.media.payload,
          }),
        );
      }
    }
    if (event.event === 'stop') {
      log.info('twilio media stream stop');
      try {
        openaiSocket.close();
      } catch {
        // ignore
      }
    }
  });

  twilioSocket.on('close', async () => {
    stats.endedAt = new Date();
    const durationSec =
      stats.startedAt && stats.endedAt
        ? Math.max(
            0,
            Math.round(
              (stats.endedAt.getTime() - stats.startedAt.getTime()) / 1000,
            ),
          )
        : 0;
    log.info(
      {
        streamSid,
        callSid,
        approvalId,
        framesFromTwilio: stats.framesFromTwilio,
        framesToTwilio: stats.framesToTwilio,
        durationSec,
      },
      'twilio stream closed',
    );

    // Cost ledger — Realtime API bills audio at ~$0.06/min input +
    // ~$0.24/min output. Stub at $0.30/min combined for v1; refine
    // to per-direction rates once OpenAI publishes per-token
    // breakdown via the API.
    if (durationSec > 0 && streamSid) {
      const minutes = durationSec / 60;
      const costUsdMicros = Math.round(minutes * 0.3 * 1_000_000);
      try {
        await costLedger.record({
          idempotencyKey: `voice_bridge:${streamSid}`,
          operation: 'llm.voice',
          provider: 'openai.realtime',
          model: 'gpt-4o-realtime-preview',
          units: durationSec,
          unitKind: 'seconds',
          costUsdMicros,
          occurredAt: stats.endedAt ?? new Date(),
        });
      } catch (err) {
        log.error({ err }, 'cost ledger write failed');
      }
    }

    try {
      openaiSocket.close();
    } catch {
      // ignore
    }
  });

  twilioSocket.on('error', (err: Error) => {
    log.error({ err }, 'twilio media ws error');
  });
}
