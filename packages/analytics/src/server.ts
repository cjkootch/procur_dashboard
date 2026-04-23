import { PostHog } from 'posthog-node';

let instance: PostHog | null = null;

export function getServerPostHog(): PostHog | null {
  const key = process.env.POSTHOG_API_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  if (!key) return null;
  if (!instance) {
    instance = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  }
  return instance;
}

export type ServerEvent = {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
};

export async function captureServerEvent(evt: ServerEvent): Promise<void> {
  const client = getServerPostHog();
  if (!client) return;
  client.capture({
    event: evt.event,
    distinctId: evt.distinctId,
    properties: evt.properties,
    groups: evt.groups,
  });
}

export async function flushServerEvents(): Promise<void> {
  const client = getServerPostHog();
  if (!client) return;
  await client.flush();
}
