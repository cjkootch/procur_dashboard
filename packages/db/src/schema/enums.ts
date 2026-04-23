import { pgEnum } from 'drizzle-orm/pg-core';

export const planTierEnum = pgEnum('plan_tier', ['free', 'pro', 'team', 'enterprise']);

export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'member', 'viewer']);

export const opportunityStatusEnum = pgEnum('opportunity_status', [
  'active',
  'closed',
  'awarded',
  'cancelled',
]);

export const pursuitStageEnum = pgEnum('pursuit_stage', [
  'identification',
  'qualification',
  'capture_planning',
  'proposal_development',
  'submitted',
  'awarded',
  'lost',
]);

export const proposalStatusEnum = pgEnum('proposal_status', [
  'drafting',
  'outline_ready',
  'in_review',
  'finalized',
  'submitted',
]);

export const contractStatusEnum = pgEnum('contract_status', ['active', 'completed', 'terminated']);

export const contractTierEnum = pgEnum('contract_tier', ['prime', 'subcontract', 'task_order']);

export const scraperRunStatusEnum = pgEnum('scraper_run_status', [
  'running',
  'success',
  'failed',
  'partial',
]);

export const alertFrequencyEnum = pgEnum('alert_frequency', ['instant', 'daily', 'weekly']);

export const regionEnum = pgEnum('region', ['caribbean', 'latam', 'africa', 'global']);
