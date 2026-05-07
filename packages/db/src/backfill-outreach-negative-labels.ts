import { and, isNull, lt } from 'drizzle-orm';
import { db } from './client';
import { outreachFeatureSnapshots } from './schema/outreach-ranking';

/**
 * Stamp `replied_within_14d = false` on snapshots that are older
 * than 14 days and still have a null label — i.e. the operator
 * proposed outreach 14+ days ago and no `outreach.replied` event
 * ever fired against the approval.
 *
 * Without this, "no reply" is indistinguishable from "not yet
 * labeled" in the training table, and the trainer can't learn
 * anything from negative examples.
 *
 * Run periodically (cron / manual) — daily or weekly is fine.
 *   pnpm --filter @procur/db backfill-outreach-negative-labels
 */

async function main(): Promise<void> {
  const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);

  const updated = await db
    .update(outreachFeatureSnapshots)
    .set({
      repliedWithin14d: false,
      labelsUpdatedAt: new Date(),
    })
    .where(
      and(
        isNull(outreachFeatureSnapshots.repliedWithin14d),
        lt(outreachFeatureSnapshots.createdAt, cutoff),
      ),
    )
    .returning({ id: outreachFeatureSnapshots.approvalId });

  console.log(`stamped ${updated.length} snapshots as replied_within_14d=false`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
