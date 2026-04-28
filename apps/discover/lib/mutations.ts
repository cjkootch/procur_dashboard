/**
 * Re-exports the catalog write helpers from @procur/catalog. See
 * queries.ts for the rationale.
 */
export { createAlertProfile, addOpportunityToPursuit } from '@procur/catalog';
export type {
  CreateAlertProfileInput,
  CreateAlertProfileResult,
  AddOpportunityToPursuitInput,
  AddOpportunityToPursuitResult,
} from '@procur/catalog';
