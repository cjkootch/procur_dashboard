import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { companies } from './companies';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    changes: jsonb('changes'),
    metadata: jsonb('metadata'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index('audit_company_idx').on(table.companyId),
    entityIdx: index('audit_entity_idx').on(table.entityType, table.entityId),
    createdIdx: index('audit_created_idx').on(table.createdAt),
  }),
);

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
