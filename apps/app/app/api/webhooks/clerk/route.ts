import { Webhook } from 'svix';
import { tasks } from '@trigger.dev/sdk/v3';
import { companies, db, users } from '@procur/db';
import { eq } from 'drizzle-orm';
import { handleClerkWebhook, type ClerkWebhookEvent } from '@procur/auth/sync';
import { recordWebhookReceipt } from '../../../../lib/webhook-events';

export const runtime = 'nodejs';

type UserCreatedData = {
  id: string;
  email_addresses?: Array<{ email_address: string; id: string }>;
  primary_email_address_id?: string | null;
  first_name?: string | null;
};

function primaryEmail(data: UserCreatedData): string {
  const primary = data.email_addresses?.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses?.[0]?.email_address ?? '';
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('CLERK_WEBHOOK_SECRET not configured', { status: 500 });
  }

  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    await recordWebhookReceipt({
      provider: 'clerk',
      eventId: svixId,
      responseStatus: 400,
      signatureValid: false,
      errorMessage: 'missing svix headers',
    });
    return new Response('missing svix headers', { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(secret);

  let event: ClerkWebhookEvent;
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as ClerkWebhookEvent;
  } catch (err) {
    await recordWebhookReceipt({
      provider: 'clerk',
      eventId: svixId,
      responseStatus: 401,
      signatureValid: false,
      errorMessage: err instanceof Error ? err.message : 'invalid signature',
    });
    return new Response('invalid signature', { status: 401 });
  }

  // Best-effort companyId lookup from event payload. Clerk org events
  // carry the org id; we map it to our company row.
  let companyIdGuess: string | null = null;
  try {
    const data = event.data as { id?: string } | undefined;
    if (data?.id && event.type.startsWith('organization')) {
      const row = await db.query.companies.findFirst({
        where: eq(companies.clerkOrgId, data.id),
        columns: { id: true },
      });
      companyIdGuess = row?.id ?? null;
    }
  } catch {
    // ignore
  }

  try {
    await handleClerkWebhook(event);
  } catch (err) {
    console.error('clerk webhook handler error', err);
    await recordWebhookReceipt({
      provider: 'clerk',
      eventId: svixId,
      eventType: event.type,
      companyId: companyIdGuess,
      responseStatus: 500,
      errorMessage: err instanceof Error ? err.message : String(err),
      payload: event,
    });
    return new Response('handler error', { status: 500 });
  }

  // Side effects on user.created: trigger welcome email (idempotency handled by
  // the task's idempotencyKey so retries won't double-send).
  if (event.type === 'user.created') {
    const data = event.data as UserCreatedData;
    try {
      const row = await db.query.users.findFirst({
        where: eq(users.clerkId, data.id),
        columns: { id: true },
      });
      if (row) {
        await tasks.trigger('welcome.new-user', {
          userId: row.id,
          clerkUserId: data.id,
          email: primaryEmail(data),
          firstName: data.first_name ?? null,
        });
      }
    } catch (err) {
      // Non-fatal — webhook delivery succeeds regardless, retry-worthy failures
      // will re-fire when Clerk retries the webhook.
      console.error('failed to trigger welcome email', err);
    }
  }

  await recordWebhookReceipt({
    provider: 'clerk',
    eventId: svixId,
    eventType: event.type,
    companyId: companyIdGuess,
    responseStatus: 200,
    processed: true,
    payload: event,
  });
  return new Response('ok', { status: 200 });
}
