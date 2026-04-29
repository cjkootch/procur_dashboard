/**
 * AISStream.io WebSocket ingest — vessel positions + static data.
 *
 * Source: https://aisstream.io/  (free, MIT-licensed open AIS feed
 *   aggregated from community receivers)
 * Auth: AISSTREAM_API_KEY in .env.local. Sign up at https://aisstream.io
 *
 * AISStream is a streaming service, not a pollable API. This worker
 * connects, subscribes to a tanker-filtered bounding box, and writes
 * each PositionReport / ShipStaticData to the DB. It runs for a
 * bounded duration (--minutes=10 by default) and exits — production
 * scheduling is a separate concern (cron / k8s deployment / etc.).
 *
 * Default scope: Mediterranean + Northwest Indian Ocean — the deal-
 * relevant box for Libyan-crude buyer inference. Override with
 * --bbox=lat1,lng1,lat2,lng2.
 *
 * Run: pnpm --filter @procur/db ingest-aisstream
 *      pnpm --filter @procur/db ingest-aisstream --minutes=60
 *      pnpm --filter @procur/db ingest-aisstream --bbox=20,40,10,80
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';

/**
 * Default bounding boxes — the deal-relevant zones VTC operates in:
 *   1. Mediterranean — Libyan loading terminals + Italian / Spanish /
 *                      Greek / Turkish refineries.
 *   2. NW Indian Ocean — Indian state-refinery destination corridor.
 *   3. Caribbean basin + US Gulf — Caribbean refining hubs (DR, JM,
 *                      TT, PR, BS), Mexican Gulf supply routes, and
 *                      the broader Atlantic approach off the Bahamas
 *                      and Cuba. Covers ~8–28°N × 98–58°W.
 *
 * Each box is [[lat_sw, lng_sw], [lat_ne, lng_ne]].
 *
 * Trade-off: each bbox adds proportional WebSocket message volume.
 * The 25-min/cycle Trigger.dev wrapper has comfortable headroom on
 * the standard tier even with three regions; if AISStream throttles,
 * narrow the boxes or split the regions across separate cron tasks.
 */
const DEFAULT_BBOXES: number[][][] = [
  [
    [30, -10],
    [47, 36],
  ], // Mediterranean
  [
    [5, 40],
    [27, 80],
  ], // NW Indian Ocean
  [
    [8, -98],
    [28, -58],
  ], // Caribbean + US Gulf
];

/** AIS ship_type codes for tankers (80-89) per the ITU spec. */
const TANKER_TYPE_CODES = new Set([80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);

function shipTypeLabel(code: number | undefined | null): string | null {
  if (code == null) return null;
  if (code === 80) return 'tanker-other';
  if (code === 81) return 'tanker-hazmat-a';
  if (code === 82) return 'tanker-hazmat-b';
  if (code === 83) return 'tanker-hazmat-c';
  if (code === 84) return 'tanker-hazmat-d';
  if (code === 85) return 'tanker-other';
  if (code === 86) return 'tanker-other';
  if (code === 87) return 'tanker-other';
  if (code === 88) return 'tanker-other';
  if (code === 89) return 'tanker-other';
  return null;
}

/** AIS nav-status code → normalized label. */
function navStatusLabel(code: number | undefined | null): string | null {
  if (code == null) return null;
  switch (code) {
    case 0:
      return 'underway';
    case 1:
      return 'at-anchor';
    case 2:
      return 'not-under-command';
    case 3:
      return 'restricted-maneuverability';
    case 4:
      return 'constrained-by-draught';
    case 5:
      return 'moored';
    case 6:
      return 'aground';
    case 7:
      return 'fishing';
    case 8:
      return 'underway-sailing';
    case 15:
      return 'undefined';
    default:
      return null;
  }
}

type AisStreamMessage = {
  Message?: {
    PositionReport?: {
      UserID?: number;
      Latitude?: number;
      Longitude?: number;
      Sog?: number; // speed over ground, knots
      Cog?: number; // course over ground, degrees
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      UserID?: number;
      Name?: string;
      ImoNumber?: number;
      Type?: number;
      Dimension?: { A: number; B: number; C: number; D: number };
      MaximumStaticDraught?: number;
      Destination?: string;
      CallSign?: string;
    };
  };
  MessageType?: 'PositionReport' | 'ShipStaticData' | string;
  /**
   * AISStream's documented spelling is `Metadata` (single 't', lower
   * 'd'), but historical code used `MetaData`. Both are accepted on
   * read so a server-side casing change won't silently null the
   * fallback fields.
   */
  Metadata?: AisStreamMetadata;
  MetaData?: AisStreamMetadata;
};

type AisStreamMetadata = {
  MMSI?: number;
  ShipName?: string;
  time_utc?: string;
  latitude?: number;
  longitude?: number;
};

function metadata(msg: AisStreamMessage): AisStreamMetadata | undefined {
  return msg.Metadata ?? msg.MetaData;
}

type ParsedPosition = {
  mmsi: string;
  lat: number;
  lng: number;
  speedKnots: number | null;
  course: number | null;
  navStatus: string | null;
  timestamp: string;
};

type ParsedStatic = {
  mmsi: string;
  name: string | null;
  imo: string | null;
  shipTypeCode: number | null;
  shipTypeLabel: string | null;
  lengthM: number | null;
  metadata: Record<string, unknown>;
};

function parsePosition(msg: AisStreamMessage): ParsedPosition | null {
  const pr = msg.Message?.PositionReport;
  if (!pr) return null;
  const meta = metadata(msg);
  const mmsi = pr.UserID ?? meta?.MMSI;
  if (mmsi == null) return null;
  const lat = pr.Latitude ?? meta?.latitude;
  const lng = pr.Longitude ?? meta?.longitude;
  if (lat == null || lng == null) return null;
  return {
    mmsi: String(mmsi),
    lat,
    lng,
    speedKnots: pr.Sog ?? null,
    course: pr.Cog ?? null,
    navStatus: navStatusLabel(pr.NavigationalStatus),
    timestamp: meta?.time_utc ?? new Date().toISOString(),
  };
}

function parseStatic(msg: AisStreamMessage): ParsedStatic | null {
  const ssd = msg.Message?.ShipStaticData;
  if (!ssd) return null;
  const meta = metadata(msg);
  const mmsi = ssd.UserID ?? meta?.MMSI;
  if (mmsi == null) return null;
  const dim = ssd.Dimension;
  const lengthM = dim ? (dim.A ?? 0) + (dim.B ?? 0) : null;
  return {
    mmsi: String(mmsi),
    name: ssd.Name?.trim() || meta?.ShipName?.trim() || null,
    imo: ssd.ImoNumber != null && ssd.ImoNumber !== 0 ? String(ssd.ImoNumber) : null,
    shipTypeCode: ssd.Type ?? null,
    shipTypeLabel: shipTypeLabel(ssd.Type),
    lengthM: lengthM != null && lengthM > 0 ? lengthM : null,
    metadata: {
      callsign: ssd.CallSign,
      draught: ssd.MaximumStaticDraught,
      destination: ssd.Destination,
    },
  };
}

async function flushPositions(
  db: ReturnType<typeof drizzle<typeof schema>>,
  positions: ParsedPosition[],
): Promise<number> {
  if (positions.length === 0) return 0;
  const values = positions.map((p) => ({
    mmsi: p.mmsi,
    lat: String(p.lat),
    lng: String(p.lng),
    speedKnots: p.speedKnots == null ? null : String(p.speedKnots),
    course: p.course == null ? null : String(p.course),
    navStatus: p.navStatus,
    timestamp: new Date(p.timestamp),
  }));
  await db.insert(schema.vesselPositions).values(values);
  // Touch last_seen_at on the vessels we just heard from.
  const mmsiList = [...new Set(positions.map((p) => p.mmsi))];
  await db.execute(sql`
    INSERT INTO vessels (mmsi, last_seen_at)
    SELECT m, NOW() FROM unnest(${mmsiList}::text[]) AS m
    ON CONFLICT (mmsi) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
  `);
  return values.length;
}

async function flushStatics(
  db: ReturnType<typeof drizzle<typeof schema>>,
  statics: ParsedStatic[],
): Promise<number> {
  if (statics.length === 0) return 0;
  // Filter to tankers + unknown — non-tankers are noise for our use case.
  const filtered = statics.filter((s) =>
    s.shipTypeCode == null ? true : TANKER_TYPE_CODES.has(s.shipTypeCode),
  );
  if (filtered.length === 0) return 0;
  for (const s of filtered) {
    await db
      .insert(schema.vessels)
      .values({
        mmsi: s.mmsi,
        imo: s.imo,
        name: s.name,
        shipTypeCode: s.shipTypeCode,
        shipTypeLabel: s.shipTypeLabel,
        lengthM: s.lengthM == null ? null : String(s.lengthM),
        metadata: s.metadata,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.vessels.mmsi,
        set: {
          imo: s.imo,
          name: s.name,
          shipTypeCode: s.shipTypeCode,
          shipTypeLabel: s.shipTypeLabel,
          lengthM: s.lengthM == null ? null : String(s.lengthM),
          metadata: s.metadata,
          updatedAt: new Date(),
        },
      });
  }
  return filtered.length;
}

export type IngestAisStreamResult = {
  minutes: number;
  bboxes: number[][][];
  positionsWritten: number;
  staticsWritten: number;
  messagesReceived: number;
};

/**
 * Connect to AISStream.io and write tanker positions + static data to
 * the DB for `minutes` minutes, then exit. Pure-function shape so the
 * Trigger.dev scheduled wrapper can reuse it; CLI shim below.
 */
export async function ingestAisStream(opts: {
  /** Default 10. */
  minutes?: number;
  /**
   * Optional bbox override. AISStream wants `[[latSW, lngSW],
   * [latNE, lngNE]]`; pass an array of those. Defaults to the
   * Mediterranean + NW Indian Ocean preset.
   */
  bboxes?: number[][][];
} = {}): Promise<IngestAisStreamResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const apiKey = process.env.AISSTREAM_API_KEY;
  if (!apiKey) {
    throw new Error(
      'AISSTREAM_API_KEY not set. Sign up at https://aisstream.io and add the key to env.',
    );
  }

  const minutes = opts.minutes ?? 10;
  const bboxes = opts.bboxes ?? DEFAULT_BBOXES;

  console.log(
    `Connecting to AISStream.io for ${minutes} minute${minutes === 1 ? '' : 's'}...`,
  );
  console.log(`  bboxes: ${JSON.stringify(bboxes)}`);

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  const ws = new WebSocket(AISSTREAM_URL);
  const positionBuffer: ParsedPosition[] = [];
  const staticBuffer: ParsedStatic[] = [];
  let positionsWritten = 0;
  let staticsWritten = 0;
  let messagesReceived = 0;
  /** Track JSON.parse failures separately. Counts toward
   *  messagesReceived but a non-zero value here means the envelope
   *  isn't text-JSON the way we expect. */
  let jsonParseErrors = 0;
  /**
   * Track shape mismatches. A "shape mismatch" is a successfully
   * parsed JSON message that didn't yield either a PositionReport
   * or ShipStaticData. The count by MessageType tag tells the
   * operator whether we're getting unrelated AIS message types
   * (the FilterMessageTypes subscription was ignored?), error
   * envelopes, or a totally different shape.
   */
  const unparsedByType = new Map<string, number>();
  /** Sample of the first 3 raw messages so we can see actual shape. */
  const SAMPLE_LIMIT = 3;
  const rawSamples: string[] = [];
  const startedAt = Date.now();

  // Periodic heartbeat — fires every 5s regardless of whether we
  // have buffered messages so silent failures (bad API key, dead
  // bbox) are visible immediately instead of looking like normal
  // post-subscribe quiet. When messages ARE arriving, the same
  // tick flushes the buffers.
  const FLUSH_EVERY_MS = 5000;
  let lastMsgsAtFlush = 0;
  const flushTimer = setInterval(async () => {
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    const posChunk = positionBuffer.splice(0, positionBuffer.length);
    const staticChunk = staticBuffer.splice(0, staticBuffer.length);
    if (posChunk.length > 0 || staticChunk.length > 0) {
      try {
        const wp = await flushPositions(db, posChunk);
        const ws2 = await flushStatics(db, staticChunk);
        positionsWritten += wp;
        staticsWritten += ws2;
        console.log(
          `  [${elapsedMin}m] positions written: ${positionsWritten} | tankers: ${staticsWritten} | msgs: ${messagesReceived}`,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.error(`  flush error: ${m}`);
      }
    } else if (messagesReceived === lastMsgsAtFlush) {
      // No buffered data AND no new messages since last tick.
      // After the first 10s of quiet, surface a hint at the
      // most-likely culprits so the operator knows to debug.
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec < 11) {
        console.log(`  [${elapsedMin}m] waiting for first message...`);
      } else if (elapsedSec < 30) {
        console.warn(
          `  [${elapsedMin}m] ⚠ no messages received yet. ` +
            `Check AISSTREAM_API_KEY (silent rejection is the most ` +
            `common cause) and bbox traffic level.`,
        );
      } else {
        console.warn(
          `  [${elapsedMin}m] ⚠ still no messages. AISStream usually ` +
            `streams within seconds of a valid subscribe; ${elapsedMin}m of ` +
            `silence almost certainly means the API key was silently ` +
            `rejected. Verify it at aisstream.io/account.`,
        );
      }
    } else {
      // Messages flowing but none parsed into our buffers — surface
      // the breakdown so the operator can see WHERE the disconnect
      // is (JSON parse vs. shape mismatch vs. unrelated MessageType).
      const topUnparsed = topNUnparsed(unparsedByType, 3);
      const breakdown = [
        jsonParseErrors > 0 ? `${jsonParseErrors} json-parse-fail` : null,
        topUnparsed,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(
        `  [${elapsedMin}m] msgs: ${messagesReceived} (no PositionReport / ShipStaticData parsed yet${
          breakdown ? `: ${breakdown}` : ''
        })`,
      );
    }
    lastMsgsAtFlush = messagesReceived;
  }, FLUSH_EVERY_MS);

  ws.addEventListener('open', () => {
    // `APIKey` (canonical capitalisation per AISStream's docs +
    // Go SDK) — the JSON field is case-insensitive in their server
    // implementation today, but the documented spelling is the
    // safer baseline. Earlier versions of this worker shipped
    // `Apikey` which silently worked; if a future server change
    // tightens parsing, the documented form survives.
    const sub = {
      APIKey: apiKey,
      BoundingBoxes: bboxes,
      // Tanker-only — keeps the stream tractable. AISStream filter
      // syntax doesn't support ship_type directly, so the static-data
      // filter happens server-side at flush time.
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    };
    ws.send(JSON.stringify(sub));
    console.log('  subscribed.');
  });

  ws.addEventListener('message', (event) => {
    messagesReceived += 1;
    // Normalize event.data — could be string, Buffer (Node ws), or
    // ArrayBuffer (some Node 21+ builds). Buffer.toString() yields
    // valid JSON; ArrayBuffer needs decoding via TextDecoder.
    let raw: string;
    if (typeof event.data === 'string') {
      raw = event.data;
    } else if (event.data instanceof ArrayBuffer) {
      raw = new TextDecoder('utf-8').decode(event.data);
    } else if (
      typeof event.data === 'object' &&
      event.data !== null &&
      'toString' in event.data
    ) {
      raw = (event.data as { toString(): string }).toString();
    } else {
      jsonParseErrors += 1;
      return;
    }

    if (rawSamples.length < SAMPLE_LIMIT) {
      // Truncate so a misbehaving server doesn't flood the log.
      rawSamples.push(raw.length > 600 ? `${raw.slice(0, 600)}…` : raw);
      console.log(
        `  [sample ${rawSamples.length}/${SAMPLE_LIMIT}] ${rawSamples.at(-1)}`,
      );
    }

    let json: AisStreamMessage;
    try {
      json = JSON.parse(raw);
    } catch {
      jsonParseErrors += 1;
      return;
    }

    const pos = parsePosition(json);
    if (pos) {
      positionBuffer.push(pos);
      return;
    }
    const stat = parseStatic(json);
    if (stat) {
      staticBuffer.push(stat);
      return;
    }

    // Successfully parsed JSON but neither PositionReport nor
    // ShipStaticData matched. Bucket by MessageType tag so the
    // operator can see whether the server is sending unrelated
    // types or our envelope expectation is wrong.
    const tag = typeof json.MessageType === 'string' ? json.MessageType : '<no-MessageType>';
    unparsedByType.set(tag, (unparsedByType.get(tag) ?? 0) + 1);
  });

  ws.addEventListener('error', (err) => {
    console.error('  WebSocket error:', err);
  });

  ws.addEventListener('close', () => {
    console.log('  WebSocket closed.');
  });

  // Run for the bounded duration, then drain + exit.
  await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  clearInterval(flushTimer);
  ws.close();

  // Final flush.
  const finalPos = await flushPositions(db, positionBuffer);
  const finalStatic = await flushStatics(db, staticBuffer);
  positionsWritten += finalPos;
  staticsWritten += finalStatic;

  console.log(
    `Done. positions=${positionsWritten}, tanker_static_records=${staticsWritten}, raw_messages=${messagesReceived}`,
  );
  if (jsonParseErrors > 0) {
    console.log(`  json_parse_errors=${jsonParseErrors}`);
  }
  if (unparsedByType.size > 0) {
    const breakdown = Array.from(unparsedByType.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}=${c}`)
      .join(', ');
    console.log(`  unparsed_by_message_type: ${breakdown}`);
  }

  return { minutes, bboxes, positionsWritten, staticsWritten, messagesReceived };
}

function topNUnparsed(map: Map<string, number>, n: number): string {
  if (map.size === 0) return '';
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t, c]) => `${t}=${c}`)
    .join(', ');
}

async function main(): Promise<void> {
  const minutesArg = process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1];
  const minutes = minutesArg ? Number.parseInt(minutesArg, 10) : 10;
  const bboxArg = process.argv.find((a) => a.startsWith('--bbox='))?.split('=')[1];
  const bboxes = bboxArg
    ? [bboxArg.split(',').reduce<number[][]>((acc, n, i) => {
        const v = Number.parseFloat(n);
        if (i % 2 === 0) acc.push([v]);
        else acc[acc.length - 1]!.push(v);
        return acc;
      }, [])]
    : undefined;

  await ingestAisStream({ minutes, bboxes });
}

if (process.argv[1] && process.argv[1].endsWith('ingest-aisstream.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
