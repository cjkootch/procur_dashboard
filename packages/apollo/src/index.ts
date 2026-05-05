/**
 * @procur/apollo — Apollo.io organization enrichment + discovery.
 *
 * Day 1 skeleton: types, config, credit-log helper, and rate
 * limiter are in place. The three top-level entry points
 * (enrichOrgFromApollo, enrichOrgsBatch, searchOrgs) and the live
 * Apollo HTTP transport land in Day 2 of the build per
 * docs/apollo-integration-brief.md §7.
 *
 * Until Day 2 lands, importing this package is safe — it does not
 * call the Apollo API, does not consume credits, and does not block
 * deployment. The cache columns and credit-log table are migrated
 * (0065) and ready to be written to.
 */

export {
  APOLLO_BASE_URL,
  APOLLO_RATE_LIMIT_PER_HOUR,
  APOLLO_BATCH_DOMAINS_PER_CALL,
  APOLLO_BATCH_FRESHNESS_DAYS,
  APOLLO_SINGLE_GET_FRESHNESS_DAYS,
  APOLLO_ENDPOINT_GET_ORG,
  APOLLO_ENDPOINT_SEARCH,
  loadApolloConfig,
  type ApolloConfig,
  type ApolloEndpoint,
} from './config';

export {
  ApolloRateLimiter,
  sharedRateLimiter,
} from './rate-limiter';

export {
  logApolloCall,
  describeApolloCallArgs,
  type LogApolloCallArgs,
} from './credit-log';

export type {
  ApolloOrgFull,
  ApolloOrgThin,
  ApolloFundingEvent,
  ApolloTechnology,
  ApolloEmployeeMetric,
  ApolloOrgSnapshot,
  ApolloSearchFilters,
  ApolloSearchResult,
  ApolloDegradeReason,
  ApolloDegradeResult,
} from './types';
