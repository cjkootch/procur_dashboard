/**
 * GAIN importer-mention resolver — local CLI wrapper.
 *
 * Loops `resolveGainMentions` until either:
 *   - All pending mentions are processed (remaining=0)
 *   - Two consecutive iterations made no progress
 *
 * Idempotent on `resolved_entity_id` — re-running picks up only the
 * still-null rows.
 *
 * Run from repo root:
 *   pnpm --filter @procur/ai resolve-gain-mentions
 *
 * Env:
 *   DATABASE_URL                       # required
 *   GAIN_RESOLVE_BATCH_SIZE=200        # mentions per iteration
 *   GAIN_RESOLVE_MIN_CONFIDENCE=0.7    # only resolve mentions ≥ this
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '@procur/db';
import { resolveGainMentions } from '../gain-extraction/resolver';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const db = drizzle(neon(process.env.DATABASE_URL), { schema });

  const limit = Number.parseInt(
    process.env.GAIN_RESOLVE_BATCH_SIZE ?? '200',
    10,
  );
  const minConfidenceRaw = process.env.GAIN_RESOLVE_MIN_CONFIDENCE;
  const minConfidence = minConfidenceRaw
    ? Number.parseFloat(minConfidenceRaw)
    : 0.7;

  console.log(
    `[gain-resolve] starting — batch=${limit} minConfidence=${minConfidence}`,
  );

  let totalMatchedExact = 0;
  let totalMatchedFuzzy = 0;
  let totalAutoCreated = 0;
  let consecutiveEmpty = 0;

  while (true) {
    const result = await resolveGainMentions(db, { limit, minConfidence });
    totalMatchedExact += result.matchedExact;
    totalMatchedFuzzy += result.matchedFuzzy;
    totalAutoCreated += result.autoCreated;
    console.log(
      `[gain-resolve] iter — processed=${result.processed} exact=${result.matchedExact} fuzzy=${result.matchedFuzzy} created=${result.autoCreated} errors=${result.errors} remaining=${result.remaining}`,
    );
    if (result.processed === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2) break;
    } else {
      consecutiveEmpty = 0;
    }
    if (result.remaining === 0) break;
  }

  console.log(
    `\n[gain-resolve] done — total exact=${totalMatchedExact} fuzzy=${totalMatchedFuzzy} auto-created=${totalAutoCreated}`,
  );
  console.log(
    `[gain-resolve] auto-created entities carry tag 'gain-curated' for audit / mass-delete.`,
  );
}

main().catch((err) => {
  console.error('[gain-resolve] FAILED', err);
  process.exit(1);
});
