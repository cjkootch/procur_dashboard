import { z } from 'zod';

/**
 * Per-entity customs-flow context — which Eurostat / UN Comtrade
 * country + HS-code rollup is relevant for the entity's macro trade
 * environment.
 *
 * Stored under `known_entities.metadata.customsContext`. Curated:
 * populated by an analyst for the top 60-80 entities (Tier 1 + Tier
 * 2 buyer pool from the bilateral counterparties research). The long
 * tail stays unstructured until commercially relevant.
 *
 * `importContext` applies when the entity is a buyer (refinery /
 * fuel distributor). Maps to import flows INTO the entity's country.
 * `exportContext` applies when the entity is a producer / marketing
 * arm. Maps to export flows FROM the entity's country (i.e., import
 * flows TO partner countries with this country as the source).
 *
 * Both are optional — an entity can carry just one or the other, or
 * both (e.g. an integrated NOC that both refines and exports).
 *
 * Brief: docs/data-graph-connections-brief.md §6 (work item 5).
 */
export const customsContextSchema = z.object({
  importContext: z
    .object({
      /** ISO-2 of the country whose imports this entity sources from. */
      reporterCountry: z.string().length(2),
      /** HS code prefixes (2/4/6 digit strings) capturing the products
       *  this entity actually trades. e.g. ["2710"] for refined
       *  petroleum, ["2709", "2710"] for crude + refined. */
      productCodeRanges: z.array(z.string()).min(1),
      /** Display label for the chat / UI surface. e.g. "Refined
       *  petroleum products". */
      relevanceLabel: z.string().min(1),
    })
    .optional(),
  exportContext: z
    .object({
      /** ISO-2 of the country whose exports this entity ships from. */
      partnerCountry: z.string().length(2),
      productCodeRanges: z.array(z.string()).min(1),
      relevanceLabel: z.string().min(1),
    })
    .optional(),
});

export type CustomsContextMapping = z.infer<typeof customsContextSchema>;

/**
 * Read the `customsContext` mapping out of a free-form
 * `known_entities.metadata` blob. Returns null when absent or
 * malformed (Zod validation failure logs nothing — caller treats
 * absence as "no context curated").
 */
export function readCustomsContext(metadata: unknown): CustomsContextMapping | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).customsContext;
  if (!raw) return null;
  const parsed = customsContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
