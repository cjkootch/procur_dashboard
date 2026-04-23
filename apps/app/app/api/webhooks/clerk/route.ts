import { Webhook } from 'svix';
import { handleClerkWebhook, type ClerkWebhookEvent } from '@procur/auth/sync';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response('CLERK_WEBHOOK_SECRET not configured', { status: 500 });
  }

  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
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
  } catch {
    return new Response('invalid signature', { status: 401 });
  }

  try {
    await handleClerkWebhook(event);
  } catch (err) {
    console.error('clerk webhook handler error', err);
    return new Response('handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
