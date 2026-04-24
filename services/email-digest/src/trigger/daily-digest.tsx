import { schedules } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';
import { alertProfiles, db, users } from '@procur/db';
import { DailyDigestEmail } from '@procur/email-templates';
import { captureServerEvent } from '@procur/analytics/server';
import { log } from '@procur/utils/logger';
import { findMatchingOpportunities, markAlertSent } from '../matching';
import { sumUsd, toEmailRow } from '../format';
import { sendEmail } from '../resend';

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

/** Daily digest: every day at 13:00 UTC (≈ 8am ET / 7am CT — Caribbean + LatAm sweet spot). */
export const dailyDigest = schedules.task({
  id: 'digest.daily',
  cron: '0 13 * * *',
  maxDuration: 900,
  run: async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

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
          eq(alertProfiles.frequency, 'daily'),
        ),
      );

    log.info('digest.daily.started', { profileCount: rows.length, cutoff: cutoff.toISOString() });

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
        const unsubUrl = `${APP_URL}/settings/alerts?profile=${profile.id}`;

        const { id } = await sendEmail({
          to: email,
          subject: `${matches.length} new tender${matches.length === 1 ? '' : 's'} today — ${profile.name}`,
          template: DailyDigestEmail({
            firstName: firstName ?? null,
            alertName: profile.name,
            opportunities: opps,
            discoverUrl: DISCOVER_URL,
            unsubscribeUrl: unsubUrl,
          }),
          tags: [
            { name: 'kind', value: 'daily_digest' },
            { name: 'profile_id', value: profile.id },
          ],
          idempotencyKey: `daily-${profile.id}-${cutoff.toISOString().slice(0, 10)}`,
        });

        await markAlertSent(profile.id);
        await captureServerEvent({
          event: 'digest_sent',
          distinctId: profile.userId,
          properties: {
            kind: 'daily',
            profileId: profile.id,
            opportunityCount: matches.length,
            resendId: id,
          },
        });
        sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ profileId: profile.id, message });
        log.error('digest.daily.profile_error', { profileId: profile.id, message });
      }
    }

    log.info('digest.daily.done', { sent, skipped, errorCount: errors.length });
    return { sent, skipped, errors };
  },
});
