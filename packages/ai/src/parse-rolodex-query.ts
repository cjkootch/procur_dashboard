/**
 * Parse a natural-language rolodex search into structured filters.
 *
 * Lightweight Haiku call. The user types something like
 * "pork suppliers in the midwest" or "approved Caribbean fuel buyers"
 * and we map it onto the existing rolodex filter dimensions:
 *
 *   - category: KNOWN_ENTITY_CATEGORIES (wheat | pork | crude-oil | …)
 *   - country: ISO-2 alpha
 *   - role: rolodex role enum (refiner | trader | producer | etc.)
 *   - tag: free-text tag literal
 *   - approval: approved | pending | rejected | expired | none
 *   - q: free-text fallback for things we can't structure
 *       (e.g. "midwest" — no state filter yet, so it lands here)
 *
 * The model is told to be conservative: when the query doesn't carry
 * a signal for a dimension, return null. The handler then drops null
 * fields from the URL so the user sees the unconstrained set in the
 * unspecified dimensions.
 */

import { z } from 'zod/v4';
import { zodOutputFormat } from './zod-output';
import { getClient, MODELS } from './client';

// These mirror packages/catalog/src/trade-taxonomy.ts. Pasted inline
// to avoid a cross-package import for a constant the LLM consumes as
// a free-text whitelist — adding the dep just to read this would
// cycle @procur/ai → @procur/catalog needlessly.
const ROLODEX_CATEGORIES = [
  'crude-oil',
  'diesel',
  'gasoline',
  'jet-fuel',
  'kerosene',
  'heating-oil',
  'fuel-oil',
  'marine-bunker',
  'naphtha',
  'gasoil',
  'lpg',
  'lng',
  'petrochemicals',
  'mining',
  'metals',
  'fertilizer',
  'food-commodities',
  'wheat',
  'corn',
  'soybean',
  'rice',
  'sugar',
  'beef',
  'pork',
  'poultry',
  'dairy',
  'oilseeds',
  'palm-oil',
  'environmental-services',
  'scrap-metals',
  'logistics',
  'shipping',
  'terminal-operator',
  'refinery-operator',
  'other',
] as const;

// Mirrors the ROLE_OPTIONS in the rolodex page.
const ROLODEX_ROLES = [
  'refiner',
  'trader',
  'producer',
  'state-buyer',
  'power-plant',
  'environmental-services',
  'fuel-buyer-industrial',
] as const;

const APPROVAL_VALUES = [
  'approved',
  'pending',
  'rejected',
  'expired',
  'none',
] as const;

export const RolodexQueryFilters = z
  .object({
    category: z
      .enum(ROLODEX_CATEGORIES)
      .nullable()
      .describe(
        'Structural commodity tag the entity should handle. Pick from the ' +
          'whitelist only. Examples: "pork suppliers" → "pork"; "diesel ' +
          'buyers" → "diesel"; "wheat millers" → "wheat"; "trading houses" ' +
          '→ null (no specific commodity); "food companies" → ' +
          '"food-commodities" (the umbrella).',
      ),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'ISO-2 alpha country code')
      .nullable()
      .describe(
        'ISO-3166-1 alpha-2 country code. "Colombia" → "CO"; "the US" → ' +
          '"US"; "Jamaica" → "JM". If the query names a multi-country ' +
          'region (Caribbean, LATAM, Mideast, EU), return null — the ' +
          'region intent moves into the free-text q field instead. ' +
          'When the user names a US state ("Iowa", "Texas"), set ' +
          'country="US" AND state=<the 2-letter code>.',
      ),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/, '2-letter state / province postal code')
      .nullable()
      .describe(
        'US state or Canadian province 2-letter postal code, uppercase. ' +
          '"Iowa" → "IA"; "Texas" → "TX"; "California" → "CA"; ' +
          '"Ontario" → "ON". Null when no state/province is named or ' +
          'when the query names a multi-state region ("midwest", ' +
          '"southeast", "Gulf Coast") — region intent goes in q.',
      ),
    role: z
      .enum(ROLODEX_ROLES)
      .nullable()
      .describe(
        'Commercial role. "suppliers" / "sellers" / "merchants" → null ' +
          '(no role match in the whitelist; rely on category instead). ' +
          '"refiners" → "refiner". "trading houses" / "traders" → ' +
          '"trader". "producers" → "producer". "state oil companies" / ' +
          '"NOCs" → "state-buyer". "fuel buyers" / "industrial fuel ' +
          'consumers" → "fuel-buyer-industrial". "power plants" → ' +
          '"power-plant".',
      ),
    tag: z
      .string()
      .max(40)
      .nullable()
      .describe(
        'Free-form tag literal IFF the query targets a known tag prefix: ' +
          '"region:mediterranean", "compatible:azeri-light", "us-grain-' +
          'seed", "libya-historic", "top-tier", "sweet-crude-runner". ' +
          'Otherwise null — do not invent tag names.',
      ),
    approval: z
      .enum(APPROVAL_VALUES)
      .nullable()
      .describe(
        'Buyer/supplier KYC state. Map prospecting / unengaged phrasing ' +
          'to "none": "prospects" / "prospect list" / "leads" / "untouched" ' +
          '/ "new" / "not engaged" / "unworked" / "fresh" → "none". ' +
          '"approved" / "vetted" / "trading-ready" / "ready to trade" ' +
          '→ "approved". "pending" / "in KYC" / "in progress" → "pending". ' +
          '"expired" / "lapsed" → "expired". "rejected" / "declined" → ' +
          '"rejected". Default null when unspecified.',
      ),
    q: z
      .string()
      .max(80)
      .nullable()
      .describe(
        'Free-text residue — terms that did not map onto any structured ' +
          'filter. Example: "pork suppliers in the midwest" → q="midwest" ' +
          '(no state-level filter exists; falls through to name/notes ' +
          'substring match). Keep short, drop articles ("the"). Null when ' +
          'every meaningful token mapped onto a structured filter.',
      ),
  })
  .strict();

export type RolodexQueryFiltersT = z.infer<typeof RolodexQueryFilters>;

const INSTRUCTION = `You translate operator natural-language rolodex queries into structured filter dimensions. The rolodex is an analyst-curated list of commercial counterparties (refiners, traders, producers, food processors, fuel buyers, etc.) across global markets.

Map the query onto these dimensions and return a JSON object. Use null for any dimension the query does not specify. Be conservative — do not invent constraints that the query does not state.

Worked examples:

  "pork suppliers in Iowa"
    → { category: "pork", country: "US", state: "IA", role: null, tag: null, approval: null, q: null }
    (named single state → emit state="IA" + country="US")

  "Texas Gulf refiners"
    → { category: null, country: "US", state: "TX", role: "refiner", tag: null, approval: null, q: "Gulf" }
    (state captured; "Gulf" regional qualifier in q)

  "pork suppliers in the midwest"
    → { category: "pork", country: "US", state: null, role: null, tag: null, approval: null, q: "midwest" }
    (multi-state region; state null, region in q)

  "approved Caribbean fuel buyers"
    → { category: null, country: null, state: null, role: "fuel-buyer-industrial", tag: null, approval: "approved", q: "Caribbean" }
    (Caribbean spans multiple countries — null country, region in q)

  "pork buyer prospects"
    → { category: "pork", country: null, state: null, role: null, tag: null, approval: "none", q: null }
    ("prospects" → approval=none. "buyer" has no role match in the
    whitelist — drop it from q since the prospects/none filter
    already captures the unengaged intent.)

  "untouched diesel leads in Jamaica"
    → { category: "diesel", country: "JM", state: null, role: null, tag: null, approval: "none", q: null }
    ("untouched" / "leads" both → approval=none. No residue in q.)

  "trading houses in Mediterranean"
    → { category: null, country: null, state: null, role: "trader", tag: "region:mediterranean", approval: null, q: null }

  "diesel refiners in Colombia"
    → { category: "diesel", country: "CO", state: null, role: "refiner", tag: null, approval: null, q: null }

  "US grain merchants"
    → { category: null, country: "US", state: null, role: null, tag: "us-grain-seed", approval: null, q: "grain" }

  "Ontario grain elevators"
    → { category: null, country: "CA", state: "ON", role: null, tag: null, approval: null, q: "grain elevator" }

  "Cargill"
    → { category: null, country: null, state: null, role: null, tag: null, approval: null, q: "Cargill" }
    (a specific entity name — defer to substring search)

Rules:
  - category MUST be from the whitelist; if no good fit, return null.
  - role MUST be from the whitelist; "supplier" / "seller" / "merchant" don't have role matches — return null and rely on category/q.
  - country: single ISO-2 only. Multi-country regions (Caribbean, EU, LATAM, Mediterranean, Mideast) → null country + region name in q (or tag if a known region:* tag exists).
  - state: emit only when ONE specific US state or Canadian province is named. Multi-state regions ("midwest", "southeast", "Gulf Coast", "PNW") → null state, region in q. Always pair state with the parent country (state="IA" requires country="US").
  - tag: only emit a tag literal if the query maps to a known prefix (region:, compatible:, or a specific tag we've already established). Do not fabricate.
  - q: short residue. Drop articles ("the", "a"). Drop tokens that have ALREADY been captured by a structured filter — specifically, drop "buyer" / "buyers" / "supplier" / "suppliers" / "merchant" / "merchants" when category and/or role were emitted; drop "prospects" / "prospect" / "leads" / "untouched" / "unengaged" / "new" when approval="none" was emitted. Keep substantive nouns only.`;

export async function parseRolodexQuery(query: string): Promise<RolodexQueryFiltersT> {
  const client = getClient();
  const response = await client.messages.parse({
    model: MODELS.haiku,
    max_tokens: 256,
    system: INSTRUCTION,
    messages: [
      {
        role: 'user',
        content: `Parse this rolodex query: ${query}`,
      },
    ],
    output_config: { format: zodOutputFormat(RolodexQueryFilters) },
  });
  if (!response.parsed_output) {
    throw new Error('parseRolodexQuery: parse failed');
  }
  return response.parsed_output;
}
