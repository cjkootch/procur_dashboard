-- known_entities.discovery_domain: text → text[]
--
-- The text column from migration 0108 was first-write-wins: the
-- first probe to discover an entity stamped the domain; subsequent
-- probes in different domains either silently lost their stamp (race
-- loser path) or rediscovered the existing entity without ever
-- updating the column. Probes whose domains weren't on the existing
-- row's stamp lost access to their own discovered targets when the
-- domain-filtered lookup ran.
--
-- text[] is the right model. NULL still = gold rolodex (curated;
-- operator promotion is sticky — never re-stamped). Single-element
-- array = one probe domain discovered the entity. Multi-element =
-- multiple probes in different domains have discovered it; all
-- should have visibility.
--
-- Filter pattern changes from:
--   discovery_domain = 'fuel_supply'
-- to:
--   'fuel_supply' = ANY(discovery_domain)
--
-- Migration uses ALTER COLUMN ... TYPE ... USING to convert in
-- place: existing non-null text values become single-element arrays.
-- Existing null values stay null.
--
-- Index needs recreation since the column type changed. Partial
-- index keeps the query plan unchanged for null-domain rows. New
-- GIN index supports ANY(array) lookups efficiently.

ALTER TABLE known_entities
  ALTER COLUMN discovery_domain TYPE text[]
  USING (
    CASE
      WHEN discovery_domain IS NULL THEN NULL
      ELSE ARRAY[discovery_domain]
    END
  );

--> statement-breakpoint

DROP INDEX IF EXISTS known_entities_discovery_domain_idx;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS known_entities_discovery_domain_idx
  ON known_entities USING GIN (discovery_domain);
