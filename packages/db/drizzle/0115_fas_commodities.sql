-- FAS commodity reference cache. Populated by ingest-fas-esr (which
-- already fetches /api/esr/commodities at start of every run).
-- Required for chat tools to return human-readable commodity names
-- alongside FAS commodity codes — the LLM doesn't know what
-- commodity_code=107 means, but knows "Soybean meal" instantly.

CREATE TABLE IF NOT EXISTS fas_commodities (
  commodity_code   INTEGER NOT NULL,
  api              TEXT NOT NULL,    -- 'esr' | 'gats' | 'psd'
  commodity_name   TEXT NOT NULL,
  unit_id          INTEGER,
  raw_payload      JSONB,
  ingested_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (commodity_code, api)
);
