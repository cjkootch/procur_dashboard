import { writeFileSync } from 'node:fs';
import { isNotNull } from 'drizzle-orm';
import { db } from './client';
import { outreachFeatureSnapshots } from './schema/outreach-ranking';

/**
 * Dump labeled snapshots from outreach_feature_snapshots to JSON
 * for the LightGBM trainer. Only rows with a non-null
 * replied_within_14d label are exported — pre-label rows are
 * still in flight and would poison training.
 *
 * Output shape:
 *   [{
 *     approval_id: string,
 *     features: { … },
 *     replied_within_14d: boolean,
 *     // additional labels passed through for future classifiers
 *     meeting_booked, converted_to_lead, converted_to_deal, disqualified
 *   }]
 */

function parseArgs(): { output: string } {
  const args = process.argv.slice(2);
  let output = 'outreach-training.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      output = args[++i] as string;
    }
  }
  return { output };
}

async function main(): Promise<void> {
  const { output } = parseArgs();
  const rows = await db
    .select()
    .from(outreachFeatureSnapshots)
    .where(isNotNull(outreachFeatureSnapshots.repliedWithin14d));

  const records = rows.map((r) => ({
    approval_id: r.approvalId,
    features: r.features,
    feature_version: r.featureVersion,
    replied_within_14d: r.repliedWithin14d,
    meeting_booked: r.meetingBooked,
    converted_to_lead: r.convertedToLead,
    converted_to_deal: r.convertedToDeal,
    disqualified: r.disqualified,
  }));

  writeFileSync(output, JSON.stringify(records, null, 2), 'utf-8');
  console.log(`wrote ${records.length} labeled snapshots → ${output}`);

  const positives = records.filter((r) => r.replied_within_14d === true).length;
  console.log(
    `  ${positives} positive (replied), ${records.length - positives} negative`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
