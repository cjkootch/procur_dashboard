-- Per-entity sanctions-screen verdicts pushed by vex's
-- SanctionsScreeningAgent.
--
-- Slice 1.6 of the procur ↔ vex integration: vex screens its
-- contacts/orgs against US Consolidated Screening List, EU
-- Consolidated Sanctions, UK OFSI (and others over time). When
-- those orgs are also known to procur (`external_keys.procur` set),
-- vex POSTs the verdict to /api/intelligence/entity/{slug}/sanctions-screen
-- and we land it here. See entity_contact_enrichments (migration 0052)
-- for the analogous suggestion-not-overwrite contract.
--
-- Append-log semantics: one row per screen run, keyed by
-- (vex_tenant_id, screen_id). Each row is immutable — a re-screen
-- produces a new row with a fresh screen_id. We never merge
-- field-by-field (unlike contact-enrichment) because a sanctions
-- verdict is point-in-time evidence, not an evolving fact.
--
-- Idempotency: vex generates screen_id (UUIDv4) per share-call. A
-- 5xx-induced retry replays the same screen_id; the UNIQUE index on
-- (vex_tenant_id, screen_id) lets us no-op cleanly via ON CONFLICT
-- DO NOTHING.
--
-- Multi-tenant: vex_tenant_id is opaque to procur — we treat it as
-- text and never deref into vex's user model. When two vex tenants
-- screen the same procur entity with different verdicts (one clear,
-- one potential_match), both rows land. Display surfaces resolve to
-- "latest per (source_list)" by default; the full multi-tenant
-- breakdown is available on request.
--
-- What we explicitly DO NOT store (per the contract review):
--   - cleared_by_operator overrides — vex's local triage decision
--     anchors procur reviewers; objective evidence stays the
--     source of truth.
--   - reviewer identity / rationale strings.
--   - raw similarity scores — the matches[] entries carry
--     confidence_band ('high_confidence' | 'fuzzy_review') only.
--   - matched name strings — leak vex's normalisation choices;
--     sdn_uid + source_list is enough for cross-reference.
--   - sub-threshold hits (vex filters < 0.85 before share).

CREATE TABLE entity_sanctions_screens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Entity attribution. Same UUID-or-slug shape getEntityProfile
  -- accepts (UUID = external_suppliers.id, slug = known_entities.slug).
  entity_slug text NOT NULL,

  -- Vex's stable per-tenant id. Opaque; persisted as text.
  vex_tenant_id text NOT NULL,
  -- Vex-generated UUIDv4 per share-call. Replay key.
  screen_id text NOT NULL,

  -- Verbatim entity name vex sent. Useful for audit + drift detection
  -- (e.g. when vex's record diverges from procur's known_entities.name).
  legal_name text NOT NULL,

  -- 'clear' | 'potential_match' | 'confirmed_match'. Validated at
  -- the route layer; left as text here so future enum additions
  -- don't need a migration.
  status text NOT NULL,

  -- Source-list codes the screen ran against. Vex emits codes from:
  --   US CSL: SDN, NS-PLC, SSI, FSE, DPL, EL, UVL, MEU, DTC, ISN, CAP
  --   EU consolidated: 'EU'
  --   UK OFSI: 'UK_OFSI'
  -- Stored as text[] so a screen against {'us_csl','eu'} carries
  -- the full coverage assertion.
  sources_checked text[] NOT NULL,

  -- Per-list match details (jsonb, one entry per matched record):
  --   { source_list, sdn_uid, programs[], confidence_band, sdn_type }
  -- Empty array when status='clear'. jsonb (not jsonb[]) so we can
  -- query containment via @> if needed without unnest gymnastics.
  matches jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- When vex performed the screen (NOT when we received the row).
  screened_at timestamp with time zone NOT NULL,

  -- Provenance — 'vex' today; reserved for future providers.
  source text NOT NULL DEFAULT 'vex',

  created_at timestamp with time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

-- Idempotency / replay key.
CREATE UNIQUE INDEX entity_sanctions_screens_dedup_idx
  ON entity_sanctions_screens (vex_tenant_id, screen_id);
--> statement-breakpoint

-- Lookup-by-entity for the entity profile + chat tool.
CREATE INDEX entity_sanctions_screens_entity_idx
  ON entity_sanctions_screens (entity_slug);
--> statement-breakpoint

-- "Show me unresolved potential matches across the rolodex" — the
-- compliance-review surface. Status filter benefits from its own
-- index when most rows are 'clear'.
CREATE INDEX entity_sanctions_screens_status_idx
  ON entity_sanctions_screens (status)
  WHERE status <> 'clear';
--> statement-breakpoint

-- Time-ordered scan for "latest screen per entity" queries.
CREATE INDEX entity_sanctions_screens_screened_at_idx
  ON entity_sanctions_screens (entity_slug, screened_at DESC);
