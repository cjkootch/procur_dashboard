import { readFileSync } from 'node:fs';
import { db } from './client';
import { outreachPredictions } from './schema/outreach-ranking';

/**
 * Read predictions from the LightGBM CLI's output and write rows to
 * outreach_predictions for audit + offline eval.
 *
 *   python -m procur_ml.outreach_ranker predict \
 *     --model lgbm-reply-14d.lgb --features unlabeled.json \
 *     > preds.json
 *   pnpm --filter @procur/db upsert-outreach-predictions \
 *     --input preds.json --model-version lgbm-reply-14d-v1
 *
 * Predictions are INTERNAL — never surfaced in operator-facing
 * copy. The table powers offline ranking eval + future "low-
 * likelihood, double-check?" prompts on the approval queue.
 */

interface PredictionRecord {
  approval_id: string;
  prob_reply_14d: number | null;
}

function parseArgs(): { input: string; modelVersion: string } {
  const args = process.argv.slice(2);
  let input: string | undefined;
  let modelVersion = 'lgbm-reply-14d-v1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      input = args[++i];
    } else if (args[i] === '--model-version' && args[i + 1]) {
      modelVersion = args[++i] as string;
    }
  }
  if (!input) {
    console.error(
      'usage: upsert-outreach-predictions --input <preds.json> [--model-version <id>]',
    );
    process.exit(2);
  }
  return { input, modelVersion };
}

async function main(): Promise<void> {
  const { input, modelVersion } = parseArgs();
  const raw = readFileSync(input, 'utf-8');
  const records = JSON.parse(raw) as PredictionRecord[];
  if (!Array.isArray(records)) {
    throw new Error(`${input} must contain a JSON array`);
  }

  const rows = records
    .filter((r) => typeof r.approval_id === 'string')
    .map((r) => ({
      approvalId: r.approval_id,
      modelVersion,
      probReply14d:
        typeof r.prob_reply_14d === 'number' ? r.prob_reply_14d : null,
    }));

  if (rows.length === 0) {
    console.log('no predictions to write');
    return;
  }

  await db.insert(outreachPredictions).values(rows);
  console.log(`wrote ${rows.length} predictions (model: ${modelVersion})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
