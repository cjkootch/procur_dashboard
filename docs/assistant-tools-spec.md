# Assistant Tools — Supplier Graph Integration

**Status:** spec, not yet implemented
**Owner:** Cole
**Last updated:** 2026-04-28
**Prerequisite:** [`docs/supplier-graph-brief.md`](./supplier-graph-brief.md) must land first — these tools call into query functions that don't exist yet.

---

## 1. What we're adding, in one paragraph

Three new read tools for the Procur assistant: `find_buyers_for_offer` (reverse search), `find_suppliers_for_tender` (buy-side recommendation), and `analyze_supplier` (drilldown). Together these let the assistant answer the questions that justify the supplier-graph build in the first place: *"Who would buy this cargo?"*, *"Who could bid on this tender?"*, and *"Tell me about this company."* Without these tools, the data we're loading into the `awards` / `external_suppliers` / `supplier_signals` tables is invisible to the chat surface.

---

## 2. Where these tools fit in the existing assistant architecture

Mirror the conventions in `apps/app/lib/assistant/`:

```
apps/app/lib/assistant/
├── registry.ts                         ← add the three new tools here
└── tools/
    ├── analyze-supplier.ts             ← NEW
    ├── find-buyers-for-offer.ts        ← NEW
    ├── find-suppliers-for-tender.ts    ← NEW
    ├── global-search.ts                  (existing — reference for style)
    ├── list-recommended-opportunities.ts (existing — reference for style)
    └── ... (existing read tools)
```

All three are **read tools** (`kind: 'read'`), not propose tools. They surface intelligence; they don't mutate state. If/when we add an "auto-create RFQ from candidate buyers" workflow that's a separate `propose-*` tool in v2.

The query implementations live in `packages/db/src/queries/` (the brief already places `reverse-search.ts` there). Tools are thin wrappers — Zod input schema, defineTool envelope, call into the query module, return the structured result.

---

## 3. Tool specifications

### 3.1 `find_buyers_for_offer`

The reverse-search tool. Given a commodity offer description, returns ranked candidate buyers from public award history.

**Question it answers:** *"A trusted broker tells me a 1M bbl Azeri Light cargo is loading Batumi in June, CIF ASWP — who in our database has bought light sweet crude in the last 5 years?"*

**File:** `apps/app/lib/assistant/tools/find-buyers-for-offer.ts`

```ts
import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { findBuyersForCommodityOffer } from '@procur/db/queries/reverse-search';

const CATEGORY_TAGS = [
  'crude-oil', 'diesel', 'gasoline', 'jet-fuel', 'lpg',
  'marine-bunker', 'heating-oil', 'heavy-fuel-oil',
  'food-commodities', 'vehicles',
] as const;

const input = z.object({
  categoryTag: z.enum(CATEGORY_TAGS).describe(
    "Internal taxonomy tag for the commodity being offered. Pick the closest match. " +
    "For Azeri Light or Brent or Bonny Light, use 'crude-oil'. For Jet A-1, use 'jet-fuel'."
  ),
  descriptionKeywords: z.array(z.string()).optional().describe(
    "Optional keywords matched (case-insensitive) against commodity_description. " +
    "Use to narrow within a category — e.g. ['light sweet', 'azeri'] for Azeri Light specifically. " +
    "Empty array = match all within the category."
  ),
  buyerCountries: z.array(z.string().length(2)).optional().describe(
    "Optional ISO-3166-1 alpha-2 country codes (e.g. ['IT','ES','GR','TR']). " +
    "Use when the cargo has geographic constraints (CIF Mediterranean, FOB Asia, etc). " +
    "Empty = global search."
  ),
  yearsLookback: z.number().min(1).max(10).default(5).describe(
    "How far back to search award history. Default 5 years."
  ),
  minAwards: z.number().min(1).default(2).describe(
    "Minimum number of matching awards a buyer must have to qualify. " +
    "Higher = more proven, fewer results. Default 2."
  ),
  limit: z.number().min(1).max(100).default(30),
});

export const findBuyersForOfferTool = defineTool({
  name: 'find_buyers_for_offer',
  description:
    "Reverse search: given a commodity offer (crude grade, refined product, food commodity, " +
    "vehicle type), find public buyers who have demonstrably bought that commodity in recent " +
    "history. Returns a ranked list ordered by recency × volume, with award counts, total USD " +
    "value, agency names, and beneficiary countries. Use this when the user describes a supplier " +
    "offer or cargo position and asks 'who would buy this' / 'who's a likely buyer' / 'who has " +
    "purchased this before'. Public-tender data only — does NOT cover private refiner-to-refiner " +
    "or trader-to-trader flows. For crude oil specifically, results skew toward national oil " +
    "companies and state refiners; private major refiners (ENI, Saras, Reliance) won't appear.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const buyers = await findBuyersForCommodityOffer({
      categoryTag: args.categoryTag,
      descriptionKeywords: args.descriptionKeywords,
      buyerCountries: args.buyerCountries,
      yearsLookback: args.yearsLookback,
      minAwards: args.minAwards,
      limit: args.limit,
    });

    return {
      count: buyers.length,
      categoryTag: args.categoryTag,
      buyers: buyers.map((b) => ({
        buyerName: b.buyerName,
        buyerCountry: b.buyerCountry,
        awardsCount: b.awardsCount,
        totalValueUsd: b.totalValueUsd,
        mostRecentAwardDate: b.mostRecentAwardDate,
        agencies: b.agencies?.slice(0, 5) ?? [],
        sampleCommodities: b.commoditiesBought?.slice(0, 3) ?? [],
        beneficiaryCountries: b.beneficiaryCountries ?? [],
      })),
      caveat:
        'Public procurement data only. Private commercial flows (major refiner crude purchases, ' +
        'trader-to-trader) are not represented. For crude grades specifically, augment with ' +
        'customs data (Kpler/Vortexa) and refinery configuration data (Argus/Platts) before ' +
        'committing to a buyer list.',
    };
  },
});
```

**Why the caveat is hard-coded into the response:** the LLM should always surface this caveat to the user when discussing crude-oil reverse-search results, otherwise it'll over-trust the public-tender list. By including it in the structured response, we make it part of the data the LLM sees — not something the LLM might or might not remember from the system prompt.

---

### 3.2 `find_suppliers_for_tender`

The buy-side workflow. Given a tender or opportunity description, returns past winners of similar awards who could plausibly bid.

**Question it answers:** *"This Jamaica Ministry of Health fuel tender just published. Who's won similar things and could realistically bid?"*

**File:** `apps/app/lib/assistant/tools/find-suppliers-for-tender.ts`

```ts
import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { findSuppliersForTender } from '@procur/db/queries/supplier-recommendation';

const input = z.object({
  opportunityId: z.string().uuid().optional().describe(
    "If provided, the tool will derive category/keywords/jurisdiction automatically from " +
    "the opportunity record. Use this when the user is looking at a specific tender. " +
    "If null, fall back to the explicit fields below."
  ),
  categoryTag: z.string().optional().describe(
    "Internal commodity category — required if opportunityId is not provided. " +
    "Same vocabulary as find_buyers_for_offer."
  ),
  descriptionKeywords: z.array(z.string()).optional(),
  buyerCountry: z.string().length(2).optional().describe(
    "ISO-2 country code of the buyer. When set, suppliers who've previously won in this " +
    "country rank higher. Often inferred from the opportunity record."
  ),
  beneficiaryCountry: z.string().length(2).optional().describe(
    "ISO-2 of the beneficiary country (where the work is delivered). " +
    "For UN/development-bank tenders, this is the actual target country."
  ),
  /** Internal: opportunity row, looked up only when opportunityId is set. */
  yearsLookback: z.number().min(1).max(10).default(5),
  limit: z.number().min(1).max(50).default(15),
});

export const findSuppliersForTenderTool = defineTool({
  name: 'find_suppliers_for_tender',
  description:
    "Given a public tender (either by opportunity ID or by explicit category/country fields), " +
    "return suppliers who have won similar awards in recent history and are plausible bidders. " +
    "Results are ranked by relevance signals: how many similar awards they've won, recency, " +
    "geographic overlap with the buyer or beneficiary country, and total contract value. Use " +
    "this when the user says 'who could bid on this' / 'who's won similar tenders' / 'should I " +
    "partner with anyone for this'. Returns supplier name, country, awards count for matching " +
    "category, recent buyers, and a brief match-reason summary.",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const result = await findSuppliersForTender(ctx.companyId, args);
    return {
      count: result.suppliers.length,
      derivedFrom: result.derivedFrom, // 'opportunity' | 'explicit_args'
      categoryTag: result.categoryTag,
      suppliers: result.suppliers.map((s) => ({
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        country: s.country,
        matchingAwardsCount: s.matchingAwardsCount,
        totalValueUsd: s.totalValueUsd,
        mostRecentAwardDate: s.mostRecentAwardDate,
        recentBuyers: s.recentBuyers?.slice(0, 5) ?? [],
        matchReasons: s.matchReasons, // string[] — same shape as opportunity matchReasons
      })),
    };
  },
});
```

**Note for Claude Code:** `findSuppliersForTender` doesn't exist yet — it's a sibling to `findBuyersForCommodityOffer`. Add it in the same file or alongside in `packages/db/src/queries/supplier-recommendation.ts`. The query is the inverse of reverse-search: same JOIN graph, but groups by supplier instead of buyer, and filters by the tender's category/country instead of by an offer spec.

---

### 3.3 `analyze_supplier`

Drilldown for a single supplier. Returns full capability summary, recent awards, buyer geography, and (when present) signals.

**Question it answers:** *"Tell me about Vitol — what have they won, who do they sell to, what's their capability?"* and *"Is this supplier we're considering actually a real player or just a paper company?"*

**File:** `apps/app/lib/assistant/tools/analyze-supplier.ts`

```ts
import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { analyzeSupplier } from '@procur/db/queries/supplier-analysis';

const input = z.object({
  supplierId: z.string().uuid().optional().describe(
    "Canonical external_suppliers.id. Use this when the supplier is already known."
  ),
  supplierName: z.string().optional().describe(
    "Free-text supplier name. Tool will resolve via supplier_aliases (trigram fuzzy match). " +
    "If multiple matches above similarity threshold, returns disambiguation options."
  ),
  yearsLookback: z.number().min(1).max(20).default(10).describe(
    "How far back to summarize. Default 10 years for full picture."
  ),
}).refine((d) => d.supplierId || d.supplierName, {
  message: 'Provide either supplierId or supplierName',
});

export const analyzeSupplierTool = defineTool({
  name: 'analyze_supplier',
  description:
    "Deep-dive on a single supplier. Returns full capability profile: total awards across " +
    "categories, top buyers, geographic footprint (where they've sold), most recent activity, " +
    "and any private signals VTC has captured (RFQ responsiveness, capability confirmations, " +
    "OFAC/credit screen results). Use this when the user names a specific supplier and wants " +
    "to know: 'are they a real player', 'what's their capability', 'who do they sell to', " +
    "'when did they last win something', or 'have we engaged with them before'. Accepts " +
    "either supplierId or supplierName (fuzzy-matched).",
  kind: 'read',
  schema: input,
  handler: async (ctx, args) => {
    const result = await analyzeSupplier(args);

    if (result.kind === 'disambiguation_needed') {
      return {
        kind: 'disambiguation_needed',
        candidates: result.candidates.map((c) => ({
          supplierId: c.supplierId,
          supplierName: c.canonicalName,
          country: c.country,
          totalAwards: c.totalAwards,
          similarityScore: c.similarityScore,
        })),
        message:
          'Multiple suppliers match that name. Ask the user to pick one (or call this tool ' +
          'again with the supplierId of the intended match).',
      };
    }

    if (result.kind === 'not_found') {
      return {
        kind: 'not_found',
        searchedFor: args.supplierName ?? args.supplierId,
        suggestion:
          'No supplier matches this name in the public award database. They may be a private ' +
          'commercial supplier (not visible in public tender data), a new entrant, or a ' +
          'name variant we have not yet aliased.',
      };
    }

    return {
      kind: 'profile',
      supplier: {
        id: result.supplier.id,
        canonicalName: result.supplier.canonicalName,
        country: result.supplier.country,
        aliases: result.supplier.aliases?.slice(0, 5) ?? [],
      },
      capabilities: {
        totalAwards: result.summary.totalAwards,
        totalValueUsd: result.summary.totalValueUsd,
        firstAwardDate: result.summary.firstAwardDate,
        mostRecentAwardDate: result.summary.mostRecentAwardDate,
        awardsByCategory: result.summary.awardsByCategory, // { 'diesel': 42, 'gasoline': 30, ... }
      },
      topBuyers: result.topBuyers.slice(0, 10),
      geography: {
        buyerCountries: result.summary.buyerCountries,
        beneficiaryCountries: result.summary.beneficiaryCountries,
      },
      recentAwards: result.recentAwards.slice(0, 5).map((a) => ({
        awardDate: a.awardDate,
        buyerName: a.buyerName,
        buyerCountry: a.buyerCountry,
        title: a.title,
        valueUsd: a.contractValueUsd,
      })),
      signals: result.signals?.slice(0, 10) ?? [], // private behavioral signals
    };
  },
});
```

**Note for Claude Code:** The disambiguation flow is important. The supplier_aliases trigram match will frequently return multiple plausible canonical suppliers (e.g. "Total" matches both "TotalEnergies Marketing Dominicana" and "Total Petroleum Caribbean"). Don't auto-pick the highest match — return the disambiguation list and let the LLM ask the user.

---

## 4. Registry update

Modify `apps/app/lib/assistant/registry.ts`:

```ts
// ... existing imports
import { findBuyersForOfferTool } from './tools/find-buyers-for-offer';
import { findSuppliersForTenderTool } from './tools/find-suppliers-for-tender';
import { analyzeSupplierTool } from './tools/analyze-supplier';

export const readTools = {
  // ... existing tools
  [findBuyersForOfferTool.name]: findBuyersForOfferTool,
  [findSuppliersForTenderTool.name]: findSuppliersForTenderTool,
  [analyzeSupplierTool.name]: analyzeSupplierTool,
} satisfies ToolRegistry;
```

---

## 5. Prompt updates — system prompt additions

The existing assistant system prompt (look in `packages/ai/src/assistant/` or wherever `prompt-blocks.ts` is consumed) needs a new section explaining when to use these tools. Suggest adding a block like this:

```
### Supplier graph

You have access to a database of public procurement awards spanning multiple
countries. When a user describes a supplier offer, cargo position, or asks
about a specific company in the procurement world, prefer these tools over
generic web knowledge:

- find_buyers_for_offer: when the user describes something a supplier is
  offering and asks who might buy it. Always quote the caveat the tool
  returns about public-tender coverage gaps.

- find_suppliers_for_tender: when the user is looking at a tender and asks
  who could bid. Pass the opportunityId if they're viewing a specific
  opportunity record; otherwise pass category and country explicitly.

- analyze_supplier: when the user names a specific supplier and wants to
  know what they've done. If the tool returns disambiguation_needed, ask
  the user to pick from the candidates rather than guessing.

Volume and recency matter more than total count. A supplier with 3 large
recent diesel awards is a better match than one with 50 small awards from
2020. Surface the dates and dollar amounts; don't just list names.

Public procurement data captures government and institutional buyers but
misses private commercial flows. For crude oil, jet fuel, and bunker fuel
specifically, this gap is significant. Always say so when results inform
a buyer-list recommendation.
```

The "volume and recency matter more than total count" line is the editorial bias that turns the tool from a list-fetcher into a recommender. Without it the LLM will dump 30 buyers in name-alphabetical order; with it, the LLM tells the user *which* buyers actually matter and *why*.

---

## 6. UI surface — what the chat looks like

The existing `apps/app/components/assistant/Chat.tsx` already streams tool results. The structured shapes returned by these three tools render cleanly in the existing message bubbles — no UI changes required for v1.

**Optional v1.5 (not blocking):** custom result components for the three tool types — a buyer table for `find_buyers_for_offer`, a supplier card grid for `find_suppliers_for_tender`, a profile panel for `analyze_supplier`. This is similar to how `list-recommended-opportunities` likely already has a custom render block. Worth adding once the base flow is working.

---

## 7. Multi-tenancy considerations

The supplier-graph data (`awards`, `external_suppliers`, `supplier_aliases`, `supplier_capability_summary`) is **public-domain** and shared across all tenants. The tool handlers don't pass `ctx.companyId` to the queries because there's nothing to scope — every Procur customer sees the same public award data.

**Exception:** `supplier_signals` may eventually contain private behavioral data captured by a specific tenant. When it does, `analyzeSupplier()` should filter signals by `ctx.companyId`. For v1 the signals table is empty, so this isn't yet an issue — but flag it in the query module so future-you doesn't accidentally leak signals between tenants.

---

## 8. Testing

Follow the existing tool test patterns. For each tool:

1. **Schema test:** Zod schema rejects malformed input.
2. **Happy-path test:** with seeded `awards_sample.json` data, calling the tool returns expected supplier/buyer rows.
3. **Empty-result test:** category with no awards returns `count: 0` cleanly, not an error.
4. **Disambiguation test (`analyze_supplier` only):** ambiguous name triggers the disambiguation branch.

Test fixtures live in `data/seed/caribbean_fuel/awards_sample.json` already. The 105-row sample includes the top 10 DR fuel suppliers with realistic diesel/gasoline/aviation award patterns — enough to exercise all three tools end-to-end.

---

## 9. Definition of done for this brief

A reasonable Claude Code session ships when:

1. The three tool files exist under `apps/app/lib/assistant/tools/` with the structure above.
2. The two new query module files exist:
   - `packages/db/src/queries/reverse-search.ts` (already specced in the supplier-graph brief)
   - `packages/db/src/queries/supplier-recommendation.ts` (NEW — `findSuppliersForTender`)
   - `packages/db/src/queries/supplier-analysis.ts` (NEW — `analyzeSupplier`)
3. `apps/app/lib/assistant/registry.ts` exports all three new tools.
4. The system prompt block from §5 is added to wherever the assistant prompt is assembled.
5. Unit tests pass (one happy-path + one edge case per tool minimum).
6. Manual test in the chat UI: ask *"who would buy 1M barrels of Azeri Light loading Batumi"* and get a structured response citing the public-tender caveat.

---

## 10. What we're explicitly NOT building yet

These belong in v2:

1. **Custom UI render components** for the tool results (mentioned in §6). Functional first, pretty later.
2. **Tools for buyer-side intelligence** (`analyze_buyer`, `find_similar_buyers`, etc.). Buyers aren't yet first-class entities the way suppliers are. Separate brief, post-v1.
3. **Outbound RFQ generation as a propose-tool** (`propose_send_rfq_to_candidates`). Once reverse-search has surfaced real candidate buyers, we'll want a workflow that drafts and sends the outreach. Wait until we've manually closed one deal before automating this.
4. **Customs / refinery-config data integration** to fill the public-tender coverage gap for crude. Listed as non-goals in the supplier-graph brief; same answer here.
5. **Supplier scoring / ranking model.** Right now ranking is rule-based (recency × volume). A learned ranker is interesting once VTC has accumulated `supplier_signals` from real RFQ outcomes — months away minimum.

---

## 11. Order of operations

1. Land the supplier-graph brief (`docs/supplier-graph-brief.md`) — schema + ingestion + reverse-search query module.
2. **Then** land this brief — three tools, two new query modules, registry update, prompt update.
3. Both can ship in a single Claude Code session if Claude Code reads both briefs upfront. The schema must come first within the session, but the order of the tool files vs. the query files doesn't matter.

---

End of brief.
