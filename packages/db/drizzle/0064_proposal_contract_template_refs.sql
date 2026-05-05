-- Wire deal_structure_templates + commission_structures catalog into
-- the existing proposals / pricing_models / contracts tables.
-- Spec: docs/deal-structures-catalog-brief.md §10.
--
-- Forward-only: existing rows get NULL slugs (per brief §10.4 — no
-- backfill of legacy free-text terms). New proposals + contracts
-- record which template they instantiated; new pricing models inherit
-- margin parameters from the template they reference.

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug);
--> statement-breakpoint

ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS applicable_commission_slugs text[]
    NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint

ALTER TABLE pricing_models
  ADD COLUMN IF NOT EXISTS deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug);
--> statement-breakpoint

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deal_structure_template_slug text
    REFERENCES deal_structure_templates(slug);
--> statement-breakpoint

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS applied_commission_slugs text[]
    NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS proposals_template_slug_idx
  ON proposals (deal_structure_template_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS pricing_models_template_slug_idx
  ON pricing_models (deal_structure_template_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contracts_template_slug_idx
  ON contracts (deal_structure_template_slug);
