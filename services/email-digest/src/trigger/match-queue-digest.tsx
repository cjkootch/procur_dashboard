import { schedules } from '@trigger.dev/sdk/v3';
import { isNotNull } from 'drizzle-orm';
import { db, users, type User } from '@procur/db';
import { getMatchQueue } from '@procur/catalog';
import {
  MatchQueueDigestEmail,
  type MatchQueueDigestRow,
} from '@procur/email-templates';
import { captureServerEvent } from '@procur/analytics/server';
import { log } from '@procur/utils/logger';
import { sendEmail } from '../resend';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
const TOP_N = 10;

/**
 * Daily match-queue digest at 16:00 UTC — 30 minutes after the
 * scoring cron at 15:30 finishes. Sends every user a ranked top-10
 * of today's open match-queue rows so the queue gets pushed in front
 * of them instead of relying on them remembering to visit.
 *
 * Opt-out via users.preferences.notifications.match_queue_digest = false.
 * (Default behaviour is opt-in: undefined / null counts as enabled,
 * matching the behaviour for users created before this feature.)
 *
 * Skipped silently for users with zero open rows so we don't spam
 * empty inboxes on quiet days.
 *
 * Idempotent on (userId, YYYY-MM-DD) so a Trigger.dev re-run on the
 * same day won't double-send.
 */
export const matchQueueDigest = schedules.task({
  id: 'digest.match-queue',
  cron: '0 16 * * *',
  maxDuration: 600,
  run: async () => {
    const today = new Date().toISOString().slice(0, 10);

    const rows = await db
      .select()
      .from(users)
      .where(isNotNull(users.companyId));
    const recipients = rows.filter(isOptedIn);

    log.info('digest.match-queue.started', {
      total: rows.length,
      eligible: recipients.length,
      today,
    });

    const matchQueueUrl = `${APP_URL}/suppliers/match-queue`;
    let sent = 0;
    let skippedEmpty = 0;
    const errors: Array<{ userId: string; message: string }> = [];

    for (const u of recipients) {
      try {
        // Tenant-scoped queue per user's company.
        const items = await getMatchQueue({
          companyId: u.companyId!,
          status: 'open',
          daysBack: 7,
          limit: 200,
        });
        const top = items.slice(0, TOP_N);
        if (top.length === 0) {
          skippedEmpty += 1;
          continue;
        }

        const digestRows: MatchQueueDigestRow[] = top.map((it) => ({
          id: it.id,
          signalType: it.signalType,
          signalKind: it.signalKind,
          score: it.score,
          entityName: it.sourceEntityName,
          entityCountry: it.sourceEntityCountry,
          rationale: it.rationale,
          observedAt: it.observedAt,
          entityProfileUrl: it.entityProfileSlug
            ? `${APP_URL}/entities/${it.entityProfileSlug}`
            : null,
        }));

        const { id: resendId } = await sendEmail({
          to: u.email,
          subject: `${top.length} match-queue lead${top.length === 1 ? '' : 's'} ranked for today`,
          template: MatchQueueDigestEmail({
            firstName: u.firstName ?? null,
            rows: digestRows,
            totalOpenCount: items.length,
            matchQueueUrl,
            unsubscribeUrl: `${APP_URL}/settings/notifications`,
          }),
          tags: [
            { name: 'kind', value: 'match_queue_digest' },
            { name: 'user_id', value: u.id },
          ],
          idempotencyKey: `match-queue-${u.id}-${today}`,
        });
        await captureServerEvent({
          event: 'digest_sent',
          distinctId: u.id,
          properties: {
            kind: 'match_queue',
            rowCount: top.length,
            totalOpenCount: items.length,
            resendId,
          },
        });
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ userId: u.id, message });
        log.error('digest.match-queue.user_error', { userId: u.id, message });
      }
    }

    log.info('digest.match-queue.done', {
      sent,
      skippedEmpty,
      skippedOptedOut: rows.length - recipients.length,
      errorCount: errors.length,
    });
    return {
      sent,
      skippedEmpty,
      skippedOptedOut: rows.length - recipients.length,
      errors,
    };
  },
});

function isOptedIn(u: User): boolean {
  // Same key the apps/app settings page writes — see
  // apps/app/lib/notification-preferences.ts (NOTIFICATION_TYPES).
  const flag = u.preferences?.notifications?.['digest.match_queue'];
  // Undefined / null counts as opted-in. Only an explicit `false`
  // disables the digest — keeps the feature opt-out.
  return flag !== false;
}
