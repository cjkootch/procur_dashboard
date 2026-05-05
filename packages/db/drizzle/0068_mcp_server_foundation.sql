-- MCP server foundation per docs/mcp-server-brief.md §4.
-- Day 1 of the build — schema + key management; the HTTP transport
-- and tool whitelist land in Day 2.
--
-- Two new tables:
--   mcp_api_keys — per-tenant API keys for external AI clients
--     (Claude Desktop, ChatGPT, Cursor, Continue.dev). Stored as
--     sha-256 hashes; raw keys are shown once at creation.
--   mcp_tool_call_log — append-only per-call observability. Mirrors
--     apollo_credit_log pattern.

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  display_suffix text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamp,
  total_calls integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_api_keys_company_idx
  ON mcp_api_keys (company_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_api_keys_status_idx
  ON mcp_api_keys (status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mcp_tool_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id uuid REFERENCES mcp_api_keys(id),
  company_id uuid REFERENCES companies(id),
  tool_name text NOT NULL,
  /** 'success' | 'tool_error' | 'auth_failed' | 'rate_limited'
      | 'tool_not_whitelisted' | 'invalid_input'. */
  outcome text NOT NULL,
  duration_ms integer,
  /** Hash of the call's input args. Lets us spot duplicate calls
      without storing potentially-sensitive criteria. */
  args_hash text,
  /** Free-text on the failure case. Empty for success. */
  error_message text,
  /** MCP host identifier from the User-Agent header when available
      (Claude Desktop, ChatGPT, Cursor, Continue, etc.). */
  host_identifier text,
  called_at timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_tool_call_log_called_at_idx
  ON mcp_tool_call_log (called_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_tool_call_log_api_key_idx
  ON mcp_tool_call_log (api_key_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mcp_tool_call_log_company_called_at_idx
  ON mcp_tool_call_log (company_id, called_at);
