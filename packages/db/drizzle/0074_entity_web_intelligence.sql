-- Website intelligence enrichment for known_entities. Per the
-- agreed-scope from chat: "company intelligence enrichment", not an
-- ML feature layer. Outreach + chat dossier lift, not graph-extraction
-- features (those land in v2 only if commercial validation justifies).
--
-- Three tables, one shared (entity_slug, source_url) audit shape:
--   entity_web_pages      — one row per crawled URL, page text in
--                           Vercel Blob (blob_url) not Postgres
--   entity_web_facts      — one row per LLM-extracted structured fact
--                           with confidence + evidence text
--   entity_web_summaries  — multi-section narrative summaries
--                           (overview / products / operations / etc.)
--
-- Confidence framing: website-extracted facts default 0.4-0.6 — these
-- are marketing self-presentation, not regulatory disclosure. EITI /
-- NI 43-101 / customs in fuel_consumption_signals stay at 0.85+.
--
-- entity_slug is text (not FK) — same canonical-key shape
-- getEntityProfile + fuel_consumption_signals + entity_embeddings
-- use. Accepts known_entities.slug or external_suppliers.id (UUID).

CREATE TABLE IF NOT EXISTS entity_web_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,

  /** Canonicalized full URL — protocol, host, path. Query strings
      stripped to avoid duplicate-page noise. */
  url text NOT NULL,

  /** Categorization that drove the crawl decision:
        'home' | 'about' | 'products' | 'services' | 'operations'
        | 'assets' | 'investors' | 'sustainability' | 'contact'
        | 'terminals' | 'refineries' | 'fleet' | 'projects' | 'other'
      Free text — new categories slot in without migration. */
  page_kind text NOT NULL,

  http_status integer,
  /** SHA-256 of the extracted plain-text content. Used to skip
      re-extraction when content hasn't changed since last crawl. */
  content_hash text,
  /** Character count of extracted text — fact-extraction skips
      pages under 200 chars (likely auth wall or empty). */
  text_length integer,
  /** Vercel Blob URL where the full extracted text lives. Null when
      the crawl bailed before storing (404, robots-disallowed, too short). */
  blob_url text,
  /** Page <title> for display. */
  title text,

  fetched_at timestamp NOT NULL DEFAULT now(),
  /** Whether robots.txt allowed the crawl. False rows still recorded
      for audit ("we tried, blocked") so a re-crawl doesn't keep retrying. */
  robots_allowed boolean NOT NULL DEFAULT true,

  /** Free-text reason if the page was skipped (robots, mime, length, etc.). */
  skip_reason text,

  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),

  UNIQUE (entity_slug, url)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_web_pages_slug_idx
  ON entity_web_pages (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_web_pages_fetched_at_idx
  ON entity_web_pages (fetched_at);
--> statement-breakpoint

-- Facts table — one row per extracted (entity, fact_type, value)
-- triple. Multiple facts of the same type per entity are allowed
-- (e.g. multiple ports, multiple products). The page that surfaced
-- the fact is referenced via source_page_id for audit drill-down.
CREATE TABLE IF NOT EXISTS entity_web_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,

  /** Free-text fact taxonomy. Capture-as-extracted; downstream code
      can normalize. Common values:
        'commercial_role' | 'product' | 'service' | 'country_served'
        | 'port' | 'terminal' | 'refinery' | 'mine' | 'power_plant'
        | 'contact_email' | 'contact_phone' | 'decision_maker_role'
        | 'certification' | 'license'  */
  fact_type text NOT NULL,
  /** The value of the fact — free text. e.g. 'diesel', 'Trinidad and Tobago',
      'Port of Kingston', 'investor.relations@example.com'. */
  value text NOT NULL,

  /** Short evidence excerpt from the page text that supports this fact —
      audit trail. Truncated to 500 chars in extraction. */
  evidence_text text,

  /** 0.0-1.0. Sonnet self-assessed confidence. Defaults to 0.5 in
      the analyst's mental model — website data is marketing self-
      presentation. See migration header. */
  confidence numeric(3, 2),

  /** Page this fact came from. ON DELETE CASCADE — when a page is
      re-crawled and replaced, its facts go too. */
  source_page_id uuid REFERENCES entity_web_pages(id) ON DELETE CASCADE,

  /** Convenience copy of the source page URL, kept current with the
      page row at insert time so chat output doesn't need a join. */
  source_url text,

  /** Sonnet model identifier. Bumping the model creates new fact
      rows; old extractions persist for diff. */
  model_version text NOT NULL,

  created_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_web_facts_slug_idx
  ON entity_web_facts (entity_slug);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_web_facts_type_idx
  ON entity_web_facts (fact_type);
--> statement-breakpoint

-- Multi-section summaries — narrative text, not structured facts.
-- One row per (entity, section_kind). Re-running summarization
-- overwrites in place via UNIQUE constraint.
CREATE TABLE IF NOT EXISTS entity_web_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_slug text NOT NULL,

  /** Section taxonomy from the agreed-scope:
        'company_overview' | 'products_services' | 'operations'
        | 'fuel_relevance' | 'crude_relevance' | 'logistics_relevance'
        | 'contact_path' */
  section_kind text NOT NULL,

  /** The summary text. Markdown-friendly. Capped at 4KB at extraction
      time so chat dossiers stay tight. */
  content text NOT NULL,

  /** Sonnet model identifier. */
  model_version text NOT NULL,

  /** When the summary was generated. */
  generated_at timestamp NOT NULL DEFAULT now(),

  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),

  UNIQUE (entity_slug, section_kind, model_version)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS entity_web_summaries_slug_idx
  ON entity_web_summaries (entity_slug);
