import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';
import { planTierEnum } from './enums';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkOrgId: text('clerk_org_id').notNull().unique(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logoUrl: text('logo_url'),
  websiteUrl: text('website_url'),

  country: text('country'),
  industry: text('industry'),
  yearFounded: integer('year_founded'),
  employeeCount: integer('employee_count'),
  annualRevenue: text('annual_revenue'),

  capabilities: text('capabilities').array(),
  preferredJurisdictions: text('preferred_jurisdictions').array(),
  preferredCategories: text('preferred_categories').array(),
  targetContractSizeMin: integer('target_contract_size_min'),
  targetContractSizeMax: integer('target_contract_size_max'),

  planTier: planTierEnum('plan_tier').default('free').notNull(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionStatus: text('subscription_status'),
  trialEndsAt: timestamp('trial_ends_at'),

  /**
   * Per-tenant monthly AI budget override in USD cents. NULL means
   * "use the plan-tier default in @procur/ai assistant/budget.ts".
   * Set by Procur staff via /tenants/[id] when a customer needs more
   * (or less) than their tier allows. Enterprise tenants typically
   * pass a number here so they get a real cap rather than the
   * default-null = unlimited behavior of the enterprise tier.
   */
  monthlyAiBudgetCents: integer('monthly_ai_budget_cents'),

  onboardingCompletedAt: timestamp('onboarding_completed_at'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
