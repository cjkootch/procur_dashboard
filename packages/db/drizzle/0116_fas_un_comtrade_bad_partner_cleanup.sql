-- ingest-fas-un-comtrade used to only resolve FAS partner codes to
-- ISO-2 for the 10 Caribbean / LATAM seed countries; every other
-- partner (Brazil, US, Argentina, etc. — i.e. most actual trading
-- partners of the seed reporters) fell through as a raw FAS numeric
-- code in customs_imports.partner_country, surfacing as garbage in
-- chat-tool output.
--
-- The code fix (this PR) broadens the GATS code resolution to use
-- gencCode → ISO-2 for every country in /api/gats/countries. After
-- this migration runs:
--   1. The bad rows (purely numeric partner_country values) are
--      deleted — they're 100% re-derivable from the next ingest run.
--   2. Operator must re-run `pnpm --filter @procur/db ingest-fas-un-comtrade`
--      to repopulate with clean ISO-2 partner_country values.
--
-- DELETE-then-rebuild is safer than backfill here because the
-- customs_imports unique index includes partner_country: an UPDATE
-- from "12" → "AR" could violate the index if the new ingest had
-- already written a row with partner_country="AR" for the same
-- (reporter, product, period). Deleting first guarantees a clean
-- re-derive.
--
-- ISO-2 country codes are 2 alphabetic chars; anything purely
-- numeric is a bad row by definition.

DELETE FROM customs_imports
 WHERE source = 'fas-un-comtrade'
   AND partner_country ~ '^[0-9]+$';
