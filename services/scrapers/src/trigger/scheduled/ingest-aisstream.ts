import { schedules } from '@trigger.dev/sdk';
import { ingestAisStream } from '@procur/db/ingest-aisstream';

/**
 * AISStream.io tanker-position ingest.
 *
 * AISStream is a streaming WebSocket; it emits while connected and
 * stays silent otherwise. This task connects, runs for `minutes`
 * minutes, then exits. Every 30 minutes a fresh task fires with a
 * 25-min run window, leaving a 5-min gap for the next instance to
 * spin up and the previous WebSocket to drain. Vessel positions
 * arrive every few seconds per active tanker, so a 5-min cold gap
 * costs at most a single ping per vessel — meaningless for trail
 * rendering at the dashboard cadence we visualize.
 *
 * If you ever need true continuous coverage, increase the run
 * length up to your Trigger.dev maxDuration ceiling and reduce the
 * cron interval to match — overlapping is harmless (idempotent on
 * (mmsi, timestamp) per vessel_positions schema).
 *
 * Bbox coverage is the worker's default (Mediterranean + NW Indian
 * Ocean). Override per-environment by passing `--bbox=...` to the
 * CLI shim, or call ingestAisStream({ bboxes: [...] }) directly.
 */
export const ingestAisStreamScheduled = schedules.task({
  id: 'ingest-aisstream',
  cron: '*/30 * * * *',
  maxDuration: 1800,
  run: async () => {
    const result = await ingestAisStream({ minutes: 25 });
    console.log(
      `AISStream: ${result.positionsWritten.toLocaleString()} positions + ` +
        `${result.staticsWritten} statics in ${result.minutes}m ` +
        `(${result.messagesReceived.toLocaleString()} raw messages).`,
    );
    return result;
  },
});
