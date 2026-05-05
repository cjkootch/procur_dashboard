-- Deal structure template + commission structure catalog. Spec:
-- docs/deal-structures-catalog-brief.md.
--
-- Two new tables capturing VTC's standard deal-shaping playbook globally:
--   * deal_structure_templates — Incoterm × payment instrument × region
--     × VTC entity bundles VTC actually offers (~25-40 templates total)
--   * commission_structures    — broker / origination partner / sub-broker
--     fee arrangements (~8-12 structures total)
--
-- Both are public-domain reference data (no per-tenant scoping). Drizzle
-- ORM + Neon HTTP — every distinct statement separated by the
-- statement-breakpoint marker per CLAUDE.md migration footguns note.

CREATE TABLE IF NOT EXISTS deal_structure_templates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  slug                        text NOT NULL UNIQUE,
  name                        text NOT NULL,

  category                    text NOT NULL,
  vtc_entity                  text NOT NULL,
  applicable_regions          text[] NOT NULL DEFAULT '{}'::text[],

  -- Commercial mechanics
  incoterm                    text NOT NULL,
  risk_transfer_point         text NOT NULL,
  payment_instrument          text NOT NULL,
  payment_currency            text NOT NULL,
  lc_confirmation_required    boolean NOT NULL DEFAULT FALSE,

  -- Insurance + inspection
  cargo_insurance             text,
  insurance_coverage_pct      numeric(5, 2),
  inspection_requirement      text,
  quality_standard            text,

  -- Documentation (ordered)
  standard_documents          text[] NOT NULL DEFAULT '{}'::text[],

  -- Timing
  typical_cycle_time_days_min integer,
  typical_cycle_time_days_max integer,
  laycan_window               text,

  -- Margin + commercial expectations
  margin_structure            text,
  typical_margin_min          numeric(10, 4),
  typical_margin_max          numeric(10, 4),
  margin_unit                 text,

  -- Risk perimeter
  ofac_screening_required     boolean NOT NULL DEFAULT TRUE,
  excluded_jurisdictions      text[] NOT NULL DEFAULT '{}'::text[],
  excluded_counterparty_types text[] NOT NULL DEFAULT '{}'::text[],
  general_license_eligible    text[] DEFAULT '{}'::text[],

  -- Counsel validation
  validated_by_counsel        boolean NOT NULL DEFAULT FALSE,
  validated_at                timestamp with time zone,
  validated_by_firm           text,
  validation_notes            text,

  -- Lifecycle
  status                      text NOT NULL DEFAULT 'draft',
  notes                       text,

  created_at                  timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at                  timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_structure_templates_category_idx
  ON deal_structure_templates (category);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_structure_templates_entity_idx
  ON deal_structure_templates (vtc_entity);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS deal_structure_templates_status_idx
  ON deal_structure_templates (status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS commission_structures (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  slug                     text NOT NULL UNIQUE,
  name                     text NOT NULL,

  category                 text NOT NULL,
  party_relationship       text NOT NULL,
  vtc_entity               text NOT NULL,

  -- Fee mechanics
  basis_type               text NOT NULL,
  fee_structure            jsonb NOT NULL,

  -- Triggering + timing
  trigger_event            text NOT NULL,
  payment_timing           text NOT NULL,

  -- Coverage
  applies_to_categories    text[] NOT NULL DEFAULT '{}'::text[],
  applies_to_template_slugs text[] NOT NULL DEFAULT '{}'::text[],
  exclusive_per_deal       boolean NOT NULL DEFAULT FALSE,
  sole_and_exclusive       boolean NOT NULL DEFAULT FALSE,

  -- Term + renewal
  term_months              integer,
  auto_renewal             boolean NOT NULL DEFAULT FALSE,
  termination_notice_days  integer,

  -- Documentation
  standard_agreement_clause text,
  tax_treatment_notes      text,

  notes                    text,
  status                   text NOT NULL DEFAULT 'draft',

  created_at               timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at               timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS commission_structures_category_idx
  ON commission_structures (category);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS commission_structures_entity_idx
  ON commission_structures (vtc_entity);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS commission_structures_status_idx
  ON commission_structures (status);
