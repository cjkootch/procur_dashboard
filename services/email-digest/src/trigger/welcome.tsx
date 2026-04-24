import { task } from '@trigger.dev/sdk/v3';
import { WelcomeEmail } from '@procur/email-templates';
import { captureServerEvent } from '@procur/analytics/server';
import { log } from '@procur/utils/logger';
import { sendEmail } from '../resend';

const DISCOVER_URL = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';

export type WelcomePayload = {
  userId: string;
  clerkUserId: string;
  email: string;
  firstName?: string | null;
};

export const welcomeTask = task({
  id: 'welcome.new-user',
  maxDuration: 60,
  run: async (payload: WelcomePayload) => {
    const { id } = await sendEmail({
      to: payload.email,
      subject: 'Welcome to Procur',
      template: WelcomeEmail({
        firstName: payload.firstName ?? null,
        appUrl: APP_URL,
        discoverUrl: DISCOVER_URL,
      }),
      tags: [
        { name: 'kind', value: 'welcome' },
        { name: 'clerk_user_id', value: payload.clerkUserId },
      ],
      idempotencyKey: `welcome-${payload.clerkUserId}`,
    });

    await captureServerEvent({
      event: 'welcome_email_sent',
      distinctId: payload.userId,
      properties: { resendId: id },
    });

    log.info('welcome.sent', { userId: payload.userId, resendId: id });
    return { resendId: id };
  },
});
