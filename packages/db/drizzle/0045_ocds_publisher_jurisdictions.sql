-- Seed the 6 jurisdictions backing the new OCDS bulk publishers
-- (services/scrapers/src/awards-extractors/ocds-bulk/publishers.ts).
-- AwardsExtractor.run() resolves jurisdiction_id by slug at the
-- start of each run, so without these rows every awards-ocds CLI
-- call fails with "jurisdiction X not found".
--
-- Idempotent — ON CONFLICT (slug) DO NOTHING — safe to re-run.
-- region values constrained by the region enum: caribbean | latam |
-- africa | global. LATAM countries map to 'latam', Nigeria to 'africa'.

INSERT INTO "jurisdictions" (
  "name", "slug", "country_code", "region",
  "portal_name", "portal_url", "currency", "language", "timezone", "active"
) VALUES
  ('Mexico Federal',     'mexico',    'MX', 'latam',
   'CompraNet (OCDS)',     'https://compranetinfo.hacienda.gob.mx/',          'MXN', 'es', 'America/Mexico_City',  TRUE),
  ('Colombia Federal',   'colombia',  'CO', 'latam',
   'SECOP II (OCDS)',      'https://www.colombiacompra.gov.co/',              'COP', 'es', 'America/Bogota',        TRUE),
  ('Paraguay Federal',   'paraguay',  'PY', 'latam',
   'DNCP (OCDS)',          'https://www.contrataciones.gov.py/',              'PYG', 'es', 'America/Asuncion',      TRUE),
  ('Honduras Federal',   'honduras',  'HN', 'latam',
   'HONDUCOMPRAS (OCDS)',  'https://honducompras.gob.hn/',                    'HNL', 'es', 'America/Tegucigalpa',   TRUE),
  ('Argentina Federal',  'argentina', 'AR', 'latam',
   'COMPR.AR (OCDS)',      'https://comprar.gob.ar/',                         'ARS', 'es', 'America/Argentina/Buenos_Aires', TRUE),
  ('Nigeria Federal',    'nigeria',   'NG', 'africa',
   'NOCOPO (OCDS)',        'https://nocopo.bpp.gov.ng/',                      'NGN', 'en', 'Africa/Lagos',          TRUE)
ON CONFLICT (slug) DO NOTHING;
