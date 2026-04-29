-- Per-contact enrichment suggestions sourced from external integrations
-- (currently vex; the schema is provider-agnostic via a `source` column).
--
-- Slice 1.5 of the procur ↔ vex integration: when vex's
-- ContactEnrichmentAgent finds a high-confidence email / title / phone /
-- linkedin URL for a contact at a procur-sourced entity, it POSTs the
-- discovery to /api/intelligence/entity/{entitySlug}/contact-enrichment
-- and we land it here.
--
-- Suggestion-not-overwrite semantics: rows in this table are sidecar
-- attributions that an operator can promote into a "primary" contacts
-- table later. Procur's existing contact-of-record (if any) is NOT
-- overwritten — vex's contribution always lands as `source = 'vex'`
-- with per-field confidence + source_url so audit trail survives.
--
-- Idempotency: repeated calls for the same logical contact merge
-- field-by-field, taking the higher-confidence value. UNIQUE on
-- (entity_slug, source, contact_name_normalized) so dedup happens at
-- write time.

CREATE TABLE entity_contact_enrichments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Entity attribution. Resolves to known_entities.slug OR
  -- external_suppliers.id (the same shape getEntityProfile accepts as
  -- canonicalKey). Stored as text since UUIDs and slugs both fit.
  entity_slug text NOT NULL,

  -- Contact identity. contact_name is the verbatim string vex sent;
  -- contact_name_normalized is the lowercased / punctuation-stripped
  -- form used for dedup.
  contact_name text NOT NULL,
  contact_name_normalized text NOT NULL,

  -- Per-field enrichment payload. Each field is optional; at least one
  -- will be non-null per row by way of the route's input validation.
  -- Confidence is 0.00-1.00, restricted to >= 0.60 by vex's filter.
  email text,
  email_confidence numeric(3, 2),
  email_source_url text,

  title text,
  title_confidence numeric(3, 2),
  title_source_url text,

  phone text,
  phone_confidence numeric(3, 2),
  phone_source_url text,

  linkedin_url text,
  linkedin_confidence numeric(3, 2),
  linkedin_source_url text,

  -- Provenance.
  source text NOT NULL DEFAULT 'vex',
  enriched_at timestamp with time zone NOT NULL,

  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Idempotency key for repeated pushes from the same source.
CREATE UNIQUE INDEX entity_contact_enrichments_dedup_idx
  ON entity_contact_enrichments (entity_slug, source, contact_name_normalized);
--> statement-breakpoint

-- Lookup-by-entity for the entity profile page (future).
CREATE INDEX entity_contact_enrichments_entity_idx
  ON entity_contact_enrichments (entity_slug);
