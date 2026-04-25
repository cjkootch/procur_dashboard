import { pgTable, uuid, text, timestamp, date, index } from 'drizzle-orm/pg-core';
import { pursuits } from './pursuits';
import { users } from './users';

export const pursuitTasks = pgTable(
  'pursuit_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pursuitId: uuid('pursuit_id')
      .references(() => pursuits.id)
      .notNull(),

    title: text('title').notNull(),
    description: text('description'),
    dueDate: date('due_date'),
    completedAt: timestamp('completed_at'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),

    priority: text('priority').default('medium'),
    category: text('category'),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pursuitIdx: index('task_pursuit_idx').on(table.pursuitId),
    dueDateIdx: index('task_due_date_idx').on(table.dueDate),
  }),
);

export type PursuitTask = typeof pursuitTasks.$inferSelect;
export type NewPursuitTask = typeof pursuitTasks.$inferInsert;
