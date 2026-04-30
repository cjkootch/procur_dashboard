-- Per-tenant supplier-approval state. Each row says "company X has
-- engaged with supplier-entity Y, current state Z." Drives the KYC
-- badge on entity profile pages, the rolodex filter chip, and the
-- assistant's preference for approved counterparties when composing
-- deals.
--
-- Status values (text + check, not enum — we want to add new states
-- without an ALTER TYPE migration):
--   pending              — outreach started, no docs exchanged yet
--   kyc_in_progress      — KYC docs submitted, supplier reviewing
--   approved_without_kyc — supplier accepts trade without formal KYC
--                          (verbal/contractual; common for smaller
--                          counterparties)
--   approved_with_kyc    — full approval, KYC complete
--   rejected             — supplier declined
--   expired              — KYC docs lapsed (typically 12-month re-cert)
--
-- entity_slug is intentionally TEXT (not a FK) because suppliers can
-- live in known_entities.slug OR external_suppliers.id (same shape
-- the entity profile resolver accepts as canonicalKey). FK would
-- couple us to one table; the slug string is the stable handle.
--
-- One approval per (company, entity) pair — UNIQUE constraint
-- enforces that. Re-engaging after a rejection or expiry is a
-- status update on the existing row, not a new row.

CREATE TABLE IF NOT EXISTS supplier_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_slug text NOT NULL,
  entity_name text,
  status text NOT NULL,
  approved_at timestamptz,
  expires_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  CONSTRAINT supplier_approvals_status_check CHECK (
    status IN (
      'pending',
      'kyc_in_progress',
      'approved_without_kyc',
      'approved_with_kyc',
      'rejected',
      'expired'
    )
  ),
  CONSTRAINT supplier_approvals_company_entity_unique UNIQUE (company_id, entity_slug)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_supplier_approvals_company_status
  ON supplier_approvals (company_id, status);
--> statement-breakpoint

COMMENT ON TABLE supplier_approvals IS
  'Per-tenant supplier-approval / KYC state. One row per (company, entity_slug).';
--> statement-breakpoint

COMMENT ON COLUMN supplier_approvals.entity_slug IS
  'Resolves to known_entities.slug OR external_suppliers.id (the same shape getEntityProfile accepts as canonicalKey). Stored as text since UUIDs and slugs both fit.';
--> statement-breakpoint

COMMENT ON COLUMN supplier_approvals.expires_at IS
  'KYC re-certification date. When non-null and in the past, the assistant + UI should treat the approval as expired and prompt re-engagement.';
