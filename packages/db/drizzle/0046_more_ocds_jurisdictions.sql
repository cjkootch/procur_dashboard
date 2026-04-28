-- Additional jurisdictions for the corrected OCDS publishers map
-- (services/scrapers/src/awards-extractors/ocds-bulk/publishers.ts).
-- The earlier 0045 migration covered mexico/colombia/paraguay/honduras
-- using best-guess publication IDs; verified IDs against
-- data.open-contracting.org swapped a few publishers and added new
-- countries:
--   - ecuador (SERCOP, USD-denominated)
--   - peru (OECE)
--   - guatemala (MOF)
--   - panama (DGCP, USD)
--   - nigeria-edo + nigeria-plateau (state-level OCDS publishers;
--     no central NOCOPO publication)
--
-- Idempotent — ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO "jurisdictions" (
  "name", "slug", "country_code", "region",
  "portal_name", "portal_url", "currency", "language", "timezone", "active"
) VALUES
  ('Ecuador Federal',        'ecuador',         'EC', 'latam',
   'SERCOP (OCDS)',           'https://www.sercop.gob.ec/',          'USD', 'es', 'America/Guayaquil', TRUE),
  ('Peru Federal',           'peru',            'PE', 'latam',
   'OECE (OCDS)',             'https://www.gob.pe/oece',             'PEN', 'es', 'America/Lima',      TRUE),
  ('Guatemala Federal',      'guatemala',       'GT', 'latam',
   'MOF (OCDS)',              'https://www.minfin.gob.gt/',          'GTQ', 'es', 'America/Guatemala', TRUE),
  ('Panama Federal',         'panama',          'PA', 'latam',
   'DGCP (OCDS)',             'https://www.dgcp.gob.pa/',            'USD', 'es', 'America/Panama',    TRUE),
  ('Nigeria Edo State',      'nigeria-edo',     'NG', 'africa',
   'Edo State PPA (OCDS)',    'https://edoppa.edostate.gov.ng/',     'NGN', 'en', 'Africa/Lagos',      TRUE),
  ('Nigeria Plateau State',  'nigeria-plateau', 'NG', 'africa',
   'Plateau BPP (OCDS)',      'https://plateaustate.gov.ng/',        'NGN', 'en', 'Africa/Lagos',      TRUE)
ON CONFLICT (slug) DO NOTHING;
