/**
 * Tool whitelist exposed via MCP. Spec: docs/mcp-server-brief.md §5.1.
 *
 * Read-only catalog tools only. Write tools, the proposal composer,
 * Apollo paid enrichment, and the heavy pricer tools are
 * deliberately excluded. The list lives here (not in the catalog
 * package) because it's an MCP-specific surface decision.
 *
 * Sized down from the 22 the brief proposed to 12 per the vex MCP
 * lesson: "5 focused tools beats 20 broad ones — LLMs hallucinate
 * less." Brief §11.2 left this as an open decision and the
 * narrower set is what shipped. We'll widen the surface once we
 * see real usage telemetry on which tools external hosts actually
 * call.
 *
 * Tools listed here that don't exist in buildCatalogTools() at
 * runtime are silently skipped (defensive — Apollo tools land
 * later per the Apollo brief Day 6).
 */
export const MCP_TOOL_WHITELIST: readonly string[] = [
  // Catalog discovery (rolodex)
  'lookup_known_entities',
  'find_counterparties_for_region',
  'find_buyers_for_offer',
  'find_competing_sellers',
  'find_caribbean_fuel_buyers',
  'analyze_supplier',

  // Free-text entity-mention resolution (Component D §7.1, PR #426).
  // High-value for chat hosts processing news / customs / document
  // text; safely returns no-match when text-embeddings haven't been
  // populated yet. predict_entity_attributes deliberately not
  // exposed — narrower flow without a clear external-host need yet.
  'resolve_entity_mention',

  // Market intelligence
  'lookup_customs_flows',
  'get_market_snapshot',
  'get_freight_estimate',
  'get_crude_basis',

  // Slate-fit (highest-leverage refinery analytic)
  'find_refineries_for_grade',

  // Catalog templates (read-only)
  'lookup_deal_structure_template',
  'lookup_commission_structures',
] as const;

export const MCP_TOOL_WHITELIST_SET: ReadonlySet<string> = new Set(MCP_TOOL_WHITELIST);
