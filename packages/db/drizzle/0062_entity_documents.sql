-- Per-tenant document attachments on rolodex entities.
--
-- Lets operators attach KYC packs, MSAs, contracts, datasheets,
-- price sheets, compliance screens, and correspondence to any
-- known_entities.slug or external_suppliers.id surfaced through
-- the entity profile page.
--
-- Distinct from the global `documents` table (which is per-
-- opportunity scraped tender content). entity_documents is
-- per-tenant private — KYC packs are sensitive; one tenant's
-- attached docs must never leak to another even if both tenants
-- have the same entity in their rolodex.
--
-- Storage: files live in Vercel Blob (same as tender uploads). The
-- DB row carries the public blob URL + metadata; deletion cascades
-- the row but leaves the blob (the upload route exposes a separate
-- delete-blob path). For per-tenant privacy, the blob URL is
-- treated as opaque — surfaces always go through the API which
-- enforces company_id scoping.

CREATE TABLE IF NOT EXISTS entity_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Per-tenant scope. Cascade ON company delete so an offboarded
  -- tenant's documents don't linger.
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Same UUID-or-slug shape getEntityProfile accepts. Text (not FK)
  -- because the entity may live in `known_entities` (slug) OR
  -- `external_suppliers` (id) — the unified profile resolves both.
  entity_slug text NOT NULL,

  -- Storage metadata.
  filename text NOT NULL,
  blob_url text NOT NULL,
  size_bytes bigint,
  mime_type text,

  -- Document category. Free text (validated at the route layer)
  -- for additive evolution. Common values:
  --   'kyc'           — KYC pack / due diligence
  --   'msa'           — Master Service Agreement
  --   'contract'      — Specific contract / SPA / proforma
  --   'datasheet'     — Product spec sheet
  --   'price-sheet'   — Pricing / quote
  --   'compliance'    — OFAC / sanctions screen / export licence
  --   'correspondence'— Email threads, meeting notes
  --   'other'
  category text,

  -- Operator's free-text description of what this doc is.
  description text,

  -- Uploader attribution. ON DELETE SET NULL preserves the doc
  -- record even when the user is offboarded (the upload still
  -- happened; the doc is still legitimate).
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,

  uploaded_at timestamp with time zone NOT NULL DEFAULT NOW(),
  created_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Primary read path: "show me X's documents for tenant Y, newest first."
CREATE INDEX IF NOT EXISTS entity_documents_company_entity_idx
  ON entity_documents (company_id, entity_slug, uploaded_at DESC);
--> statement-breakpoint

-- Filterable category lookup ("show me all KYC packs") — partial
-- index because most rows will carry a category.
CREATE INDEX IF NOT EXISTS entity_documents_category_idx
  ON entity_documents (company_id, category, uploaded_at DESC)
  WHERE category IS NOT NULL;
