import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
} from 'drizzle-orm/pg-core';
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

  /**
   * Trading-economics preferences — used as defaults by
   * compose_deal_economics when the per-call input doesn't override.
   * See migration 0053 for column-level docs.
   */
  defaultSourcingRegion: text('default_sourcing_region'),
  targetGrossMarginPct: numeric('target_gross_margin_pct'),
  targetNetMarginPerUsg: numeric('target_net_margin_per_usg'),
  monthlyFixedOverheadUsdDefault: integer('monthly_fixed_overhead_usd_default'),

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

  /**
   * External integration IDs for the user's own org — HubSpot id,
   * Salesforce id, vex deal-system id, etc. Per the
   * vex-into-procur merge brief Phase 1 (docs/vex-into-procur-merge-brief.md).
   * Shape: `{ hubspot: "12345", vex: "01HW...", ... }`. Default `{}`
   * so reads are safe before population.
   */
  externalKeys: jsonb('external_keys')
    .notNull()
    .default({})
    .$type<Record<string, string>>(),

  /**
   * Per-company email defaults applied to every approved email.send.
   * Migration 0081. Read by `applyEmailSend` at dispatch; managed
   * at /settings/email.
   */
  emailSenderDisplayName: text('email_sender_display_name'),
  emailAlwaysCc: jsonb('email_always_cc')
    .notNull()
    .default([])
    .$type<string[]>(),
  emailSignatureHtml: text('email_signature_html'),
  emailSignatureText: text('email_signature_text'),

  /**
   * Conversation-agent persona (migration 0093). Used by
   * @procur/catalog/conversation-agent.ts to substitute concrete values
   * into the SMS / WhatsApp / email draft system prompt. NULL falls
   * back to a generic "the operator's company" line — concrete values
   * stop the model from emitting "[Operator Company Name]" literally.
   *
   *   agentOperatorName   — first name the agent signs as ("Cole")
   *   agentPersonaBlurb   — short free-text positioning, injected
   *                         verbatim into the prompt
   *   agentSignatureSms   — 1-2-word signoff ("— Cole, Procur")
   */
  agentOperatorName: text('agent_operator_name'),
  agentPersonaBlurb: text('agent_persona_blurb'),
  agentSignatureSms: text('agent_signature_sms'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
