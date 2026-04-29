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
 * Default bounding boxes — the tightest crude-deal-relevant areas:
 *   1. Mediterranean (incl. Libyan loading + Italian/Spanish/Greek/Turkish refineries)
 *   2. Northwest Indian Ocean (the Indian state-refinery destination corridor)
 *
 * Each box is [[lat_sw, lng_sw], [lat_ne, lng_ne]].
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
  MetaData?: {
    MMSI?: number;
    ShipName?: string;
    time_utc?: string;
    latitude?: number;
    longitude?: number;
  };
};

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
  const mmsi = pr.UserID ?? msg.MetaData?.MMSI;
  if (mmsi == null) return null;
  const lat = pr.Latitude ?? msg.MetaData?.latitude;
  const lng = pr.Longitude ?? msg.MetaData?.longitude;
  if (lat == null || lng == null) return null;
  return {
    mmsi: String(mmsi),
    lat,
    lng,
    speedKnots: pr.Sog ?? null,
    course: pr.Cog ?? null,
    navStatus: navStatusLabel(pr.NavigationalStatus),
    timestamp: msg.MetaData?.time_utc ?? new Date().toISOString(),
  };
}

function parseStatic(msg: AisStreamMessage): ParsedStatic | null {
  const ssd = msg.Message?.ShipStaticData;
  if (!ssd) return null;
  const mmsi = ssd.UserID ?? msg.MetaData?.MMSI;
  if (mmsi == null) return null;
  const dim = ssd.Dimension;
  const lengthM = dim ? (dim.A ?? 0) + (dim.B ?? 0) : null;
  return {
    mmsi: String(mmsi),
    name: ssd.Name?.trim() || msg.MetaData?.ShipName?.trim() || null,
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
  const startedAt = Date.now();

  // Periodic flush — keeps memory bounded + writes in healthy chunks.
  const FLUSH_EVERY_MS = 5000;
  const flushTimer = setInterval(async () => {
    if (positionBuffer.length === 0 && staticBuffer.length === 0) return;
    const posChunk = positionBuffer.splice(0, positionBuffer.length);
    const staticChunk = staticBuffer.splice(0, staticBuffer.length);
    try {
      const wp = await flushPositions(db, posChunk);
      const ws2 = await flushStatics(db, staticChunk);
      positionsWritten += wp;
      staticsWritten += ws2;
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      console.log(
        `  [${elapsedMin}m] positions written: ${positionsWritten} | tankers: ${staticsWritten} | msgs: ${messagesReceived}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  flush error: ${m}`);
    }
  }, FLUSH_EVERY_MS);

  ws.addEventListener('open', () => {
    const sub = {
      Apikey: apiKey,
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
    let json: AisStreamMessage;
    try {
      json = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    } catch {
      return;
    }
    const pos = parsePosition(json);
    if (pos) positionBuffer.push(pos);
    const stat = parseStatic(json);
    if (stat) staticBuffer.push(stat);
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

  return { minutes, bboxes, positionsWritten, staticsWritten, messagesReceived };
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
