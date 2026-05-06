-- Vex-into-procur merge, Phase 1: schema additions.
-- Per docs/vex-into-procur-merge-brief.md and
-- docs/vex-into-procur-merge-decisions.md.
--
-- Adds:
--   - 23 new pg enums (record_status, lead_status, deal_*, cashflow_*, etc.)
--   - 34 new tables (CRM + agent runtime + sales + comms + fuel-deal stack)
--   - external_keys jsonb on companies
--   - 6 OFAC enrichment columns on entity_sanctions_screens
--
-- Phase 0 decisions applied:
--   - tenant_id columns dropped from all incoming vex tables (single-user
--     scoping per docs/vex-into-procur-merge-decisions.md)
--   - workspaces / tenants tables NOT ported
--   - users / vessels / ports / documents NOT reconciled — procur's win
--   - vex's organizations ports as a NEW table (CRM-counterparty), distinct
--     from procur's companies (the user's own Clerk org)
--
-- All CREATE TYPE / CREATE TABLE / CREATE INDEX use IF NOT EXISTS so a
-- partial-failure replay is safe (Neon HTTP is auto-commit per call;
-- no transaction wrapper).

-- ============================================================================
-- ENUMS
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE record_status AS ENUM ('active', 'inactive', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM ('new', 'qualified', 'disqualified', 'won', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM ('active', 'paused', 'completed', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE raw_event_status AS ENUM ('pending', 'processed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE agent_run_status AS ENUM ('pending', 'running', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE approval_decision AS ENUM ('pending', 'approved', 'rejected', 'auto_approved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE deal_status AS ENUM (
    'draft', 'negotiating', 'pending_approval', 'approved', 'loading',
    'in_transit', 'delivered', 'settled', 'cancelled', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE deal_type AS ENUM ('spot', 'program', 'tender', 'spot_with_option');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE product_type AS ENUM (
    'ulsd', 'gasoline_87', 'gasoline_91', 'jet_a', 'jet_a1',
    'avgas', 'lfo', 'hfo', 'lng', 'lpg', 'biodiesel_b20',
    'rice', 'beans', 'pork', 'chicken', 'cooking_oil', 'powdered_milk'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE incoterm AS ENUM ('fob', 'cif', 'cfr', 'dap', 'exw', 'fas');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE pricing_basis AS ENUM (
    'platts', 'argus', 'opis', 'nymex_wti', 'nymex_rbob',
    'ice_brent', 'fixed', 'negotiated'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE payment_terms AS ENUM (
    'prepayment_100', 'prepayment_80_20', 'lc_sight', 'lc_60d',
    'lc_90d', 'lc_120d', 'sblc', 'open_account',
    'telegraphic_transfer', 'mixed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE deal_currency AS ENUM (
    'usd', 'eur', 'cad', 'jmd', 'ttd', 'dop', 'bbd', 'xcd'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE vessel_type AS ENUM (
    'tanker_mr', 'tanker_lr1', 'tanker_lr2', 'tanker_vlcc',
    'barge', 'coastal_tanker', 'isocontainer', 'flexitank'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE vessel_class AS ENUM (
    'handysize', 'handymax', 'panamax', 'aframax', 'suezmax', 'vlcc',
    'mr_tanker', 'lr1', 'lr2', 'coastal', 'barge', 'container',
    'reefer', 'bulk_carrier'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE freight_basis AS ENUM (
    'per_usg', 'lump_sum', 'worldscale', 'time_charter_eq'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE ofac_screening_status AS ENUM (
    'not_started', 'in_progress', 'cleared', 'flagged', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE scenario_type AS ENUM (
    'base', 'conservative', 'aggressive', 'stress', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE cashflow_direction AS ENUM ('inflow', 'outflow');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE cashflow_event_type AS ENUM (
    'buyer_prepayment', 'buyer_final_payment', 'lc_payment',
    'product_purchase', 'freight_payment', 'freight_deposit',
    'insurance_premium', 'port_fees', 'compliance_fees',
    'bank_fees', 'intermediary_fee', 'storage_fees',
    'demurrage', 'overhead', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE cashflow_base_type AS ENUM (
    'revenue', 'product_cost', 'freight', 'insurance',
    'port_handling', 'compliance', 'finance', 'overhead', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE deal_document_type AS ENUM (
    'term_sheet', 'loi', 'spa', 'lc', 'sblc', 'bl', 'coa', 'q88',
    'inspection_report', 'ofac_screening', 'bis_license', 'eei',
    'insurance_cert', 'customs_entry', 'invoice', 'packing_list',
    'sddr', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE counterparty_risk_tier AS ENUM (
    'tier_1', 'tier_2', 'tier_3', 'watch', 'declined'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- ============================================================================
-- ALTER companies — add external_keys
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS external_keys jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- ============================================================================
-- ALTER entity_sanctions_screens — OFAC enrichment columns
-- ============================================================================

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS ofac_highest_score double precision;
--> statement-breakpoint

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS ofac_match_count integer;
--> statement-breakpoint

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS ofac_screened_at timestamp with time zone;
--> statement-breakpoint

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS cleared_by text;
--> statement-breakpoint

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS cleared_at timestamp with time zone;
--> statement-breakpoint

ALTER TABLE entity_sanctions_screens
  ADD COLUMN IF NOT EXISTS cleared_reason text;
--> statement-breakpoint

-- ============================================================================
-- LAYER 0: tables with no FKs to other new tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  legal_name text NOT NULL,
  domain text,
  industry text,
  geo jsonb,
  fit_score double precision,
  source_of_truth text,
  external_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  kind text,
  ofac_status text NOT NULL DEFAULT 'unscreened',
  ofac_screened_at timestamp with time zone,
  ofac_highest_score double precision,
  status record_status NOT NULL DEFAULT 'active',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organizations_status_idx ON organizations (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_domain_idx ON organizations (domain);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_external_keys_gin_idx ON organizations USING gin (external_keys);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  agent_name text NOT NULL,
  status agent_run_status NOT NULL DEFAULT 'pending',
  input_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd double precision NOT NULL DEFAULT 0,
  error text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_runs_created_at_idx ON agent_runs (created_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS cost_ledger (
  id text PRIMARY KEY,
  agent_run_id text,
  idempotency_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  provider text NOT NULL,
  model text,
  units bigint NOT NULL,
  unit_kind text NOT NULL,
  cost_usd_micros bigint NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS cost_ledger_occurred_at_idx ON cost_ledger (occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_ledger_agent_run_idx ON cost_ledger (agent_run_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS embedding_chunks (
  id text PRIMARY KEY,
  owner_object_type text NOT NULL,
  owner_object_id text NOT NULL,
  chunk_text text NOT NULL,
  search_vector tsvector,
  embedding vector(1536) NOT NULL,
  permission_scope text NOT NULL DEFAULT 'workspace',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS embedding_chunks_owner_idx ON embedding_chunks (owner_object_type, owner_object_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS embedding_chunks_search_vector_idx ON embedding_chunks USING gin (search_vector) WHERE search_vector IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS raw_events (
  id text NOT NULL,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  received_at timestamp with time zone NOT NULL,
  checksum text,
  status raw_event_status NOT NULL DEFAULT 'pending'
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS raw_events_received_at_idx ON raw_events (received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS raw_events_provider_event_uniq ON raw_events (received_at, provider, provider_event_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS events (
  id text NOT NULL,
  verb text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  actor_type text,
  actor_id text,
  object_type text,
  object_id text,
  occurred_at timestamp with time zone NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events (occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_subject_idx ON events (subject_type, subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_uniq ON events (occurred_at, idempotency_key);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS activities (
  id text PRIMARY KEY,
  type text NOT NULL,
  related_object_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp with time zone NOT NULL,
  result text,
  transcript_ref text,
  duration_seconds integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS activities_occurred_at_idx ON activities (occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS activities_type_idx ON activities (type);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS summaries (
  id text PRIMARY KEY,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  summary_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  content text NOT NULL,
  validity_window_start timestamp with time zone,
  validity_window_end timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS summaries_subject_idx ON summaries (subject_type, subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS summaries_unique_per_version ON summaries (subject_type, subject_id, summary_type, version);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS signals (
  id text PRIMARY KEY,
  rule_id text NOT NULL,
  severity text NOT NULL DEFAULT 'warn',
  subject_type text,
  subject_id text,
  title text NOT NULL,
  body text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  acknowledged_at timestamp with time zone,
  acknowledged_by text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS signals_created_at_idx ON signals (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signals_rule_idx ON signals (rule_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS signals_subject_idx ON signals (subject_type, subject_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS threads (
  id text PRIMARY KEY,
  channel text NOT NULL,
  subject text,
  participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_message_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS threads_channel_idx ON threads (channel);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS threads_last_message_at_idx ON threads (last_message_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS follow_ups (
  id text PRIMARY KEY,
  title text NOT NULL,
  note text,
  due_at timestamp with time zone NOT NULL,
  subject_type text,
  subject_id text,
  assigned_to text,
  created_by text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  completed_at timestamp with time zone,
  notified_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT follow_ups_status_check CHECK (status IN ('open', 'completed', 'cancelled'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS follow_ups_due_idx ON follow_ups (status, due_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS follow_ups_subject_idx ON follow_ups (subject_type, subject_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS campaigns (
  id text PRIMARY KEY,
  channel text NOT NULL,
  source text,
  medium text,
  account_ref text,
  spend double precision,
  objective text,
  external_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
  status campaign_status NOT NULL DEFAULT 'active',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS campaigns_channel_idx ON campaigns (channel);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_market_rates (
  id text PRIMARY KEY,
  rate_date date NOT NULL,
  product text NOT NULL,
  benchmark text NOT NULL,
  price_per_usg double precision NOT NULL,
  price_per_bbl double precision NOT NULL,
  price_per_mt double precision NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  source text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_market_rates_product_benchmark_idx ON fuel_market_rates (product, benchmark);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_market_rates_date_idx ON fuel_market_rates (rate_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fuel_market_rates_uniq_per_day ON fuel_market_rates (rate_date, product, benchmark);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS freight_rates (
  id text PRIMARY KEY,
  rate_date date NOT NULL,
  origin_region text NOT NULL,
  destination_region text NOT NULL,
  vessel_class vessel_class NOT NULL,
  product_category text NOT NULL,
  rate_usd_per_mt double precision NOT NULL,
  worldscale_points double precision,
  source text NOT NULL,
  source_reference text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS freight_rates_route_idx ON freight_rates (origin_region, destination_region, vessel_class, rate_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS freight_rates_uniq ON freight_rates (rate_date, origin_region, destination_region, vessel_class, product_category, source);
--> statement-breakpoint

-- ============================================================================
-- LAYER 1: tables FK'ing into Layer 0 only
-- ============================================================================

CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  title text,
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  role_score double precision,
  external_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  status record_status NOT NULL DEFAULT 'active',
  merged_into_contact_id text,
  timezone text,
  primary_language text,
  opt_out_at timestamp with time zone,
  opt_out_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_status_idx ON contacts (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_merged_into_idx ON contacts (merged_into_contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_emails_gin_idx ON contacts USING gin (emails);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_phones_gin_idx ON contacts USING gin (phones);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_external_keys_gin_idx ON contacts USING gin (external_keys);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS organization_products (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product text NOT NULL,
  notes text,
  added_by text,
  added_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS organization_products_org_product_uq ON organization_products (org_id, product);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organization_products_product_idx ON organization_products (product);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS organization_relationships (
  id text PRIMARY KEY,
  from_org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  to_org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  product text,
  notes text,
  added_by text,
  added_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organization_relationships_from_idx ON organization_relationships (from_org_id, relationship_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organization_relationships_to_idx ON organization_relationships (to_org_id, relationship_type);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  agent_run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  proposed_payload jsonb NOT NULL,
  reviewer_id text,
  decision approval_decision NOT NULL DEFAULT 'pending',
  decided_at timestamp with time zone,
  applied_object_id text,
  applied_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS approvals_decision_idx ON approvals (decision);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS approvals_agent_run_idx ON approvals (agent_run_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction message_direction NOT NULL,
  content_ref text,
  sentiment text,
  outcome text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS campaign_steps (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position integer NOT NULL,
  channel text NOT NULL,
  delay_after_prior_ms integer NOT NULL DEFAULT 0,
  template_ref text,
  subject_override text,
  body_override text,
  gate_condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  tier text NOT NULL DEFAULT 'T2',
  auto_approve boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_steps_campaign_idx ON campaign_steps (campaign_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS campaign_steps_position_uniq ON campaign_steps (campaign_id, position);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS procur_intelligence_snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  procur_tool text NOT NULL,
  query_hash text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS procur_snapshots_org_tool_idx ON procur_intelligence_snapshots (org_id, procur_tool);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS procur_snapshots_expires_idx ON procur_intelligence_snapshots (expires_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS procur_snapshots_unique_idx ON procur_intelligence_snapshots (org_id, procur_tool, query_hash);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS port_events (
  id text PRIMARY KEY,
  port_slug text NOT NULL REFERENCES ports(slug) ON DELETE CASCADE,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone,
  title text NOT NULL,
  body text,
  source_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS port_events_port_idx ON port_events (port_slug, starts_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS port_events_active_idx ON port_events (starts_at, ends_at);
--> statement-breakpoint

-- ============================================================================
-- LAYER 2: tables FK'ing into Layers 0 + 1
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_org_memberships (
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text,
  is_primary boolean NOT NULL DEFAULT false,
  since timestamp with time zone NOT NULL DEFAULT now(),
  until timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, org_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_org_memberships_org_idx ON contact_org_memberships (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_org_memberships_contact_idx ON contact_org_memberships (contact_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS contact_org_memberships_one_primary_per_contact ON contact_org_memberships (contact_id) WHERE is_primary;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS leads (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  owner_id text,
  status lead_status NOT NULL DEFAULT 'new',
  stage text,
  qualification_summary text,
  external_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
  procur_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS leads_org_idx ON leads (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leads_contact_idx ON leads (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leads_external_keys_gin_idx ON leads USING gin (external_keys);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'enrolled',
  last_event_at timestamp with time zone,
  branch_history_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_enrollments_campaign_idx ON campaign_enrollments (campaign_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS campaign_enrollments_contact_idx ON campaign_enrollments (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS campaign_enrollments_state_idx ON campaign_enrollments (state);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS campaign_enrollments_uniq ON campaign_enrollments (campaign_id, contact_id);
--> statement-breakpoint

-- ============================================================================
-- LAYER 3: cross-domain root tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS touchpoints (
  id text PRIMARY KEY,
  channel text NOT NULL,
  actor text,
  occurred_at timestamp with time zone NOT NULL,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  lead_id text REFERENCES leads(id) ON DELETE SET NULL,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS touchpoints_occurred_at_idx ON touchpoints (occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS touchpoints_campaign_idx ON touchpoints (campaign_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS touchpoints_lead_idx ON touchpoints (lead_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS touchpoints_contact_idx ON touchpoints (contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS touchpoints_org_idx ON touchpoints (org_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deals (
  id text PRIMARY KEY,
  deal_ref text NOT NULL,
  status deal_status NOT NULL DEFAULT 'draft',
  deal_type deal_type NOT NULL DEFAULT 'spot',
  deal_frequency text NOT NULL DEFAULT 'one_off',
  deal_frequency_interval_days integer,
  deal_frequency_notes text,
  product product_type NOT NULL,
  product_grade text,
  product_spec_notes text,
  origin_country text,
  origin_port text,
  origin_terminal text,
  destination_country text,
  destination_port text,
  destination_terminal text,
  incoterm incoterm NOT NULL,
  pricing_basis pricing_basis NOT NULL,
  pricing_formula text,
  price_lock_date date,
  price_lock_time text,
  volume_usg double precision NOT NULL,
  volume_mt double precision,
  volume_bbls double precision,
  density_kg_l double precision,
  volume_tolerance_pct double precision NOT NULL DEFAULT 0,
  line_of_business text NOT NULL DEFAULT 'fuel',
  volume_unit text NOT NULL DEFAULT 'usg',
  production_lead_time_weeks integer,
  cold_chain_required boolean NOT NULL DEFAULT false,
  currency deal_currency NOT NULL DEFAULT 'usd',
  fx_rate_to_usd double precision NOT NULL DEFAULT 1,
  fx_hedge_in_place boolean NOT NULL DEFAULT false,
  fx_hedge_rate double precision,
  fx_hedge_instrument text,
  fx_hedge_expiry date,
  buyer_org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  buyer_contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  seller_org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  intermediary_org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  intermediary_role text,
  buy_side_broker_org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  buy_side_broker_commission_pct double precision,
  buy_side_broker_payment_terms text,
  sell_side_broker_org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  sell_side_broker_commission_pct double precision,
  sell_side_broker_payment_terms text,
  lead_id text REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  laycan_start date,
  laycan_end date,
  bl_date_estimated date,
  bl_date_actual date,
  eta_destination date,
  eta_actual date,
  payment_terms payment_terms NOT NULL,
  lc_issuing_bank text,
  lc_confirming_bank text,
  lc_value_usd double precision,
  lc_expiry_date date,
  lc_margin_pct double precision,
  sblc_value_usd double precision,
  trade_finance_cost_pct double precision NOT NULL DEFAULT 0,
  ofac_screening_status ofac_screening_status NOT NULL DEFAULT 'not_started',
  bis_license_required boolean NOT NULL DEFAULT false,
  bis_license_number text,
  bis_license_expiry date,
  eei_filing_required boolean NOT NULL DEFAULT false,
  eei_itn text,
  compliance_hold boolean NOT NULL DEFAULT false,
  compliance_notes text,
  counterparty_risk_score double precision,
  country_risk_score double precision,
  political_risk_insured boolean NOT NULL DEFAULT false,
  vessel_id text,
  vessel_utilization_pct double precision,
  freight_rate_usd_per_mt double precision,
  freight_rate_locked_at timestamp with time zone,
  freight_rate_source text,
  freight_market_rate_at_lock double precision,
  demurrage_rate_usd_per_day double precision,
  ballast_bonus_usd double precision,
  charter_type text,
  origin_port_id text,
  destination_port_id text,
  notes text,
  internal_notes text,
  created_by text,
  approved_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deals_status_idx ON fuel_deals (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_buyer_idx ON fuel_deals (buyer_org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_product_idx ON fuel_deals (product);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_laycan_idx ON fuel_deals (laycan_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_created_at_idx ON fuel_deals (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_deal_ref_idx ON fuel_deals (deal_ref);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_vessel_idx ON fuel_deals (vessel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_origin_port_idx ON fuel_deals (origin_port_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deals_destination_port_idx ON fuel_deals (destination_port_id);
--> statement-breakpoint

-- ============================================================================
-- LAYER 4: fuel-deal child tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS fuel_deal_cost_stack (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  product_cost_per_usg double precision NOT NULL,
  product_quality_premium_usg double precision NOT NULL DEFAULT 0,
  product_cost_basis text,
  vessel_name text,
  vessel_imo text,
  vessel_flag text,
  vessel_type vessel_type,
  vessel_capacity_usg double precision,
  vessel_utilization_pct double precision,
  freight_basis freight_basis NOT NULL DEFAULT 'per_usg',
  freight_rate_raw double precision NOT NULL DEFAULT 0,
  freight_rate_per_usg double precision NOT NULL DEFAULT 0,
  freight_currency deal_currency NOT NULL DEFAULT 'usd',
  demurrage_rate_per_day double precision,
  demurrage_allowed_hours double precision,
  demurrage_days_estimated double precision,
  demurrage_cost_estimated double precision,
  despatch_rate_per_day double precision,
  port_dues_load_usd double precision,
  port_dues_discharge_usd double precision,
  canal_transit_cost_usd double precision,
  bunkering_cost_usd double precision,
  freight_total_usd double precision NOT NULL DEFAULT 0,
  freight_per_usg_all_in double precision NOT NULL DEFAULT 0,
  cargo_insurance_pct double precision NOT NULL DEFAULT 0,
  cargo_insurance_usd double precision NOT NULL DEFAULT 0,
  war_risk_premium_pct double precision,
  war_risk_usd double precision,
  pi_contribution_usd double precision,
  political_risk_premium_pct double precision,
  political_risk_usd double precision,
  total_insurance_per_usg double precision NOT NULL DEFAULT 0,
  discharge_port_fee_usd double precision,
  storage_fee_per_day_usd double precision,
  storage_days_estimated double precision,
  storage_cost_usd double precision,
  customs_clearance_usd double precision,
  inspection_fee_usd double precision,
  sampling_testing_usd double precision,
  shore_tank_rental_usd double precision,
  blending_cost_usd double precision,
  discharge_handling_per_usg double precision NOT NULL DEFAULT 0,
  ofac_screening_fee_usd double precision,
  bis_license_fee_usd double precision,
  eei_filing_fee_usd double precision,
  compliance_legal_usd double precision,
  kyc_aml_cost_usd double precision,
  sanctions_insurance_usd double precision,
  total_compliance_per_usg double precision NOT NULL DEFAULT 0,
  lc_fee_usd double precision,
  lc_discount_fee_usd double precision,
  bank_guarantee_fee_usd double precision,
  trade_finance_total_usd double precision NOT NULL DEFAULT 0,
  trade_finance_per_usg double precision NOT NULL DEFAULT 0,
  intermediary_fee_pct double precision,
  intermediary_fee_usd double precision,
  local_agent_fee_usd double precision,
  brokerage_pct double precision,
  brokerage_usd double precision,
  total_agent_per_usg double precision NOT NULL DEFAULT 0,
  vtc_variable_ops_per_usg double precision NOT NULL DEFAULT 0,
  overhead_allocation_usd double precision NOT NULL DEFAULT 0,
  overhead_per_usg double precision NOT NULL DEFAULT 0,
  total_landed_cost_per_usg double precision NOT NULL DEFAULT 0,
  gross_margin_per_usg double precision NOT NULL DEFAULT 0,
  gross_margin_pct double precision NOT NULL DEFAULT 0,
  net_margin_per_usg double precision NOT NULL DEFAULT 0,
  net_margin_pct double precision NOT NULL DEFAULT 0,
  ebitda_usd double precision NOT NULL DEFAULT 0,
  breakeven_sell_price_usg double precision NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_cost_stack_deal_idx ON fuel_deal_cost_stack (deal_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_cashflow_events (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  day_relative integer NOT NULL,
  label text NOT NULL,
  direction cashflow_direction NOT NULL,
  event_type cashflow_event_type NOT NULL,
  base_type cashflow_base_type NOT NULL,
  amount_pct double precision,
  amount_fixed_usd double precision,
  amount_calculated_usd double precision NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  fx_rate double precision NOT NULL DEFAULT 1,
  counterparty text,
  payment_method text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_cashflow_events_deal_idx ON fuel_deal_cashflow_events (deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deal_cashflow_events_deal_day_idx ON fuel_deal_cashflow_events (deal_id, day_relative);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_scenarios (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  scenario_name text NOT NULL,
  scenario_type scenario_type NOT NULL DEFAULT 'base',
  is_active boolean NOT NULL DEFAULT false,
  volume_usg_override double precision,
  sell_price_per_usg double precision NOT NULL,
  product_cost_override double precision,
  freight_override_per_usg double precision,
  fx_rate_override double precision,
  demurrage_days_override double precision,
  storage_days_override double precision,
  results_json jsonb,
  score double precision,
  recommendation text,
  calculated_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_scenarios_deal_idx ON fuel_deal_scenarios (deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deal_scenarios_active_idx ON fuel_deal_scenarios (deal_id, is_active);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_counterparty_scores (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scored_at timestamp with time zone NOT NULL DEFAULT now(),
  scored_by text,
  country_risk double precision NOT NULL,
  payment_history_risk double precision NOT NULL,
  credit_risk double precision NOT NULL,
  sanctions_exposure_risk double precision NOT NULL,
  ownership_transparency_risk double precision NOT NULL,
  regulatory_complexity_risk double precision NOT NULL,
  operational_risk double precision NOT NULL,
  concentration_risk double precision NOT NULL,
  composite_score double precision NOT NULL,
  risk_tier counterparty_risk_tier NOT NULL,
  recommended_payment_terms text,
  recommended_max_exposure_usd double precision,
  notes text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_counterparty_scores_org_idx ON fuel_deal_counterparty_scores (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deal_counterparty_scores_tier_idx ON fuel_deal_counterparty_scores (risk_tier);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_documents (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  document_type deal_document_type NOT NULL,
  storage_key text NOT NULL,
  filename text NOT NULL,
  uploaded_by text,
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  notes text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_documents_deal_idx ON fuel_deal_documents (deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deal_documents_type_idx ON fuel_deal_documents (deal_id, document_type);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_market_context (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  benchmark_code text NOT NULL,
  benchmark_spot_usd double precision,
  effective_benchmark_usd double precision,
  offer_delta_usd double precision,
  offer_delta_pct double precision,
  historical_mean_delta_pct double precision,
  historical_median_delta_pct double precision,
  historical_stddev_delta_pct double precision,
  historical_sample_size integer,
  z_score double precision,
  percentile double precision,
  verdict text NOT NULL,
  rationale text,
  fetched_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_market_context_verdict_idx ON fuel_deal_market_context (verdict);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fuel_deal_market_context_deal_unique ON fuel_deal_market_context (deal_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS fuel_deal_participants (
  id text PRIMARY KEY,
  deal_id text NOT NULL REFERENCES fuel_deals(id) ON DELETE CASCADE,
  party_type text NOT NULL,
  org_id text REFERENCES organizations(id) ON DELETE SET NULL,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  commission_type text NOT NULL DEFAULT 'none',
  commission_value double precision,
  commission_notes text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS fuel_deal_participants_deal_idx ON fuel_deal_participants (deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fuel_deal_participants_org_idx ON fuel_deal_participants (org_id);
