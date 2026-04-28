/**
 * @procur/catalog — public-catalog query layer + AI tool registry
 * shared by the Discover widget and the main app's assistant.
 *
 * Re-exports everything via three named submodules:
 *   - queries.ts: SQL helpers (listOpportunities, pricingIntel, …)
 *   - mutations.ts: write helpers (createAlertProfile, addOpportunityToPursuit)
 *   - tools.ts: AI tool registry factory + URL helpers
 *
 * Apps that only need the tools can import from `@procur/catalog/tools`.
 */
export * from './queries';
export * from './mutations';
export {
  buildCatalogTools,
  buildFilterUrl,
  describeFilters,
  DISCOVER_BASE,
} from './tools';
