import 'server-only';
import { and, desc, eq, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { companies, db, webhookEvents } from '@procur/db';

export type WebhookFilter = {
  provider?: 'stripe' | 'clerk';
  /** 'ok' | 'error' — narrows by signature_valid + response_status. */
  status?: 'ok' | 'rejected' | 'error';
  companyId?: string;
  page?: number;
};

export type WebhookRow = {
  id: string;
  provider: string;
  eventId: string | null;
  eventType: string | null;
  companyId: string | null;
  companyName: string | null;
  signatureValid: boolean;
  responseStatus: number;
  processedAt: Date | null;
  errorMessage: string | null;
  payload: unknown;
  receivedAt: Date;
};

export type WebhookPage = {
  rows: WebhookRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

const PAGE_SIZE = 50;

/**
 * Paginated webhook receipts for the admin viewer.
 *
 * Status buckets:
 *   ok       → signature valid AND response 2xx
 *   rejected → signature invalid (Stripe / Clerk gave us bad bytes)
 *   error    → signature valid AND response 5xx (handler crashed)
 *
 * No count(*) — fetch PAGE_SIZE+1 and toggle hasMore from the +1.
 */
export async function listWebhookEvents(filter: WebhookFilter = {}): Promise<WebhookPage> {
  const conds: SQL[] = [];
  if (filter.provider) conds.push(eq(webhookEvents.provider, filter.provider));
  if (filter.companyId) conds.push(eq(webhookEvents.companyId, filter.companyId));
  if (filter.status === 'ok') {
    conds.push(eq(webhookEvents.signatureValid, true));
    conds.push(isNotNull(webhookEvents.processedAt));
  } else if (filter.status === 'rejected') {
    conds.push(eq(webhookEvents.signatureValid, false));
  } else if (filter.status === 'error') {
    conds.push(eq(webhookEvents.signatureValid, true));
    conds.push(isNull(webhookEvents.processedAt));
  }

  const page = Math.max(1, filter.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await db
    .select({
      id: webhookEvents.id,
      provider: webhookEvents.provider,
      eventId: webhookEvents.eventId,
      eventType: webhookEvents.eventType,
      companyId: webhookEvents.companyId,
      companyName: companies.name,
      signatureValid: webhookEvents.signatureValid,
      responseStatus: webhookEvents.responseStatus,
      processedAt: webhookEvents.processedAt,
      errorMessage: webhookEvents.errorMessage,
      payload: webhookEvents.payload,
      receivedAt: webhookEvents.receivedAt,
    })
    .from(webhookEvents)
    .leftJoin(companies, eq(companies.id, webhookEvents.companyId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  return {
    rows: visible.map((r) => ({
      id: r.id,
      provider: r.provider,
      eventId: r.eventId,
      eventType: r.eventType,
      companyId: r.companyId,
      companyName: r.companyName,
      signatureValid: r.signatureValid,
      responseStatus: r.responseStatus,
      processedAt: r.processedAt,
      errorMessage: r.errorMessage,
      payload: r.payload,
      receivedAt: r.receivedAt,
    })),
    page,
    pageSize: PAGE_SIZE,
    hasMore,
  };
}

export const WEBHOOK_PAGE_SIZE = PAGE_SIZE;
