import 'server-only';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import {
  auditLog,
  companies,
  db,
  users,
} from '@procur/db';

export type AuditFilter = {
  /** Restrict to one tenant. */
  companyId?: string;
  /** Exact match on action string (e.g. 'pursuit.created'). */
  action?: string;
  /** Filter by entity type. */
  entityType?: string;
  /** ISO date string YYYY-MM-DD; inclusive. */
  fromDate?: string;
  /** ISO date string YYYY-MM-DD; inclusive (we add 1 day server-side). */
  toDate?: string;
  /** 1-indexed page. */
  page?: number;
};

const PAGE_SIZE = 100;

export type AuditRow = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  userId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  changes: unknown;
  metadata: unknown;
  createdAt: Date;
};

export type AuditPage = {
  rows: AuditRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalEstimate: number;
};

/**
 * Paginated audit log query for the admin viewer.
 *
 * Uses the existing audit_company_idx + audit_created_idx; filters
 * compose into a single AND. We don't paginate by total count (the
 * audit_log table grows unbounded — count(*) is expensive). Instead we
 * fetch PAGE_SIZE+1 rows; if we get the +1, hasMore is true.
 */
export async function listAuditEvents(filter: AuditFilter = {}): Promise<AuditPage> {
  const conds: SQL[] = [];
  if (filter.companyId) conds.push(eq(auditLog.companyId, filter.companyId));
  if (filter.action) conds.push(eq(auditLog.action, filter.action));
  if (filter.entityType) conds.push(eq(auditLog.entityType, filter.entityType));
  if (filter.fromDate) {
    conds.push(gte(auditLog.createdAt, new Date(`${filter.fromDate}T00:00:00Z`)));
  }
  if (filter.toDate) {
    // Inclusive end-of-day.
    const endOfDay = new Date(`${filter.toDate}T00:00:00Z`);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);
    conds.push(lte(auditLog.createdAt, endOfDay));
  }

  const page = Math.max(1, filter.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await db
    .select({
      id: auditLog.id,
      companyId: auditLog.companyId,
      companyName: companies.name,
      userId: auditLog.userId,
      actorEmail: users.email,
      actorFirstName: users.firstName,
      actorLastName: users.lastName,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      changes: auditLog.changes,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(companies, eq(companies.id, auditLog.companyId))
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset(offset);

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  return {
    rows: visible.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      companyName: r.companyName,
      userId: r.userId,
      actorEmail: r.actorEmail,
      actorName:
        [r.actorFirstName, r.actorLastName].filter(Boolean).join(' ') || null,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      changes: r.changes,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
    page,
    pageSize: PAGE_SIZE,
    hasMore,
    totalEstimate: offset + visible.length + (hasMore ? PAGE_SIZE : 0),
  };
}

/** Distinct action strings seen recently (last 30 days), for the filter dropdown. */
export async function listRecentActions(): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .where(gte(auditLog.createdAt, cutoff))
    .orderBy(auditLog.action);
  return rows.map((r) => r.action);
}

/**
 * Tenants list for the filter dropdown. Limited list — typically 10s
 * to 100s. Same query as listTenants() but trimmed to the dropdown
 * shape so we don't load every count for every render.
 */
export async function listTenantOptions(): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(companies.name);
  return rows;
}

export const AUDIT_PAGE_SIZE = PAGE_SIZE;
