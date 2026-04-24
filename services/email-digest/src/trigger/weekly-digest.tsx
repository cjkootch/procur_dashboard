import { schedules } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';
import { alertProfiles, db, users } from '@procur/db';
import { WeeklyDigestEmail } from '@procur/email-templates';
import { captureServerEvent } from '@procur/analytics/server';
import { log } from '@procur/utils/logger';
import { findMatchingOpportunities, markAlertSent } from '../matching';
import { sumUsd, toEmailRow } from '../format';
import { sendEmail } from '../resend';

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

/** Weekly digest: every Monday at 13:00 UTC. */
export const weeklyDigest = schedules.task({
  id: 'digest.weekly',
  cron: '0 13 * * 1',
  maxDuration: 900,
  run: async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        profile: alertProfiles,
        email: users.email,
        firstName: users.firstName,
      })
      .from(alertProfiles)
      .innerJoin(users, eq(users.id, alertProfiles.userId))
      .where(
        and(
          eq(alertProfiles.active, true),
          eq(alertProfiles.emailEnabled, true),
          eq(alertProfiles.frequency, 'weekly'),
        ),
      );

    log.info('digest.weekly.started', { profileCount: rows.length, cutoff: cutoff.toISOString() });

    let sent = 0;
    let skipped = 0;
    const errors: Array<{ profileId: string; message: string }> = [];

    for (const { profile, email, firstName } of rows) {
      try {
        const since = profile.lastSentAt ?? cutoff;
        const matches = await findMatchingOpportunities(profile, since);
        if (matches.length === 0) {
          skipped += 1;
          continue;
        }

        const opps = matches.map((m) => toEmailRow(m, DISCOVER_URL));
        const unsubUrl = `${APP_URL}/alerts/${profile.id}`;

        const { id } = await sendEmail({
          to: email,
          subject: `Your week in tenders: ${matches.length} matching ${profile.name}`,
          template: WeeklyDigestEmail({
            firstName: firstName ?? null,
            alertName: profile.name,
            opportunities: opps,
            totalValueUsd: sumUsd(matches),
            discoverUrl: DISCOVER_URL,
            unsubscribeUrl: unsubUrl,
          }),
          tags: [
            { name: 'kind', value: 'weekly_digest' },
            { name: 'profile_id', value: profile.id },
          ],
          idempotencyKey: `weekly-${profile.id}-${cutoff.toISOString().slice(0, 10)}`,
        });

        await markAlertSent(profile.id);
        await captureServerEvent({
          event: 'digest_sent',
          distinctId: profile.userId,
          properties: {
            kind: 'weekly',
            profileId: profile.id,
            opportunityCount: matches.length,
            resendId: id,
          },
        });
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ profileId: profile.id, message });
        log.error('digest.weekly.profile_error', { profileId: profile.id, message });
      }
    }

    log.info('digest.weekly.done', { sent, skipped, errorCount: errors.length });
    return { sent, skipped, errors };
  },
});
