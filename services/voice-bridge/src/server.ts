import 'dotenv/config';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { handleTwilioStream } from './bridge';

/**
 * Procur voice-bridge per docs/vex-into-procur-merge-brief.md
 * Phase 7.5. Long-lived WebSocket service that bridges Twilio Media
 * Streams ↔ OpenAI Realtime API. Deployed as a Fly app (Vercel
 * Functions can't host long-lived WS connections).
 *
 * Routes:
 *   GET /health         — liveness check (Fly's default)
 *   WSS /twilio-stream  — Twilio Media Streams entry point. Twilio
 *                          opens this WS when the call's TwiML
 *                          response includes <Connect><Stream url="wss://...">
 *
 * Procur's TwiML route at /api/webhooks/twilio/twiml emits the
 * <Connect><Stream> verb pointing here when ?mode=ai is set on
 * the outbound call URL.
 */

const PORT = Number(process.env.PORT ?? 3030);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

await app.register(websocketPlugin);

app.get('/health', async () => ({
  ok: true,
  service: 'procur-voice-bridge',
  uptimeSeconds: Math.round(process.uptime()),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.get('/twilio-stream', { websocket: true }, (socket: any, req) => {
  app.log.info(
    { remote: req.ip, ua: req.headers['user-agent'] ?? 'unknown' },
    'twilio-stream open',
  );
  handleTwilioStream(socket, app.log).catch((err) => {
    app.log.error({ err }, 'bridge handler crashed');
    try {
      socket.close();
    } catch {
      // ignore
    }
  });
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`procur-voice-bridge listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
