# Libyan Crude Buyer Brief — 1M+ bbl/month placement

Working document for the active Libyan crude brokerage deal. Prioritized
candidate buyer list with rationale, public-tender visibility, and
suggested outreach angles. Pair with `/suppliers/known-entities` (the
in-app rolodex with the same data) and `/suppliers/intelligence` (live
public-tender flows).

## Cargo profile (assumed)

- Volume: 1M+ bbl/month — multiple Aframax/Suezmax cargoes or one
  VLCC every ~3 months
- Grade: Es Sider / Sharara / Bouri (light sweet, ~36–44 API,
  low-sulfur). Brent-like crude characteristics
- Loading: presumed Mediterranean (Es Sider terminal, Mellitah,
  Zueitina) — proximity bias toward Mediterranean buyers but
  competitive with West African sweets for Asian destinations
- Pricing reference: dated Brent + grade differential

## Strategic framing

Public-tender data shows you ~10–15% of the realistic buyer universe
for this cargo. The other ~85% is private commercial flow (European
majors, private Asian refiners, trading houses) that **does not appear
in any public tender feed, ever**. For deal-velocity that gap matters:
to see whose ships actually load Libyan barrels right now you need
customs/AIS data (Kpler, Vortexa, ImportGenius), not procurement data.

**Recommended next step before deep outreach:** one-month subscription
to Kpler or Vortexa (~$5–10K) gives vessel-level confirmation of recent
Libyan crude offtakers across 2024–2025. Pays for itself on first
cargo.

The list below is what we know from public-domain research + industry
reporting, organized by likelihood of taking this cargo.

## Tier 1 — Highest probability

**Eni-operated Italian refineries (Sannazzaro, Taranto)**
- Capacity: 200 + 105 kbd, complex, configured for sweet diet
- Eni partners with NOC Libya via Mellitah Oil & Gas — preferential
  access to Libyan grades; this is the single most plausible buyer pool
- Outreach: Eni Trading & Shipping (Geneva). Crude-procurement desk
- Tender visibility: NONE (private commercial)

**Repsol Cartagena + Bilbao (Petronor), Spain**
- Capacity: 220 + 220 kbd, both complex
- Repsol Exploration has Sharara block partnership — active Libyan
  upstream presence; refining side is consistent buyer
- Outreach: Repsol Trading SA (Madrid)
- Tender visibility: NONE

**ISAB / Priolo (Sicily)**
- 360 kbd, two-train, sweet-crude-runner
- Ownership transferred from Lukoil to GOI Energy in 2023 — verify
  current sanctions posture before pitching; was a major Libyan crude
  taker historically
- Outreach: GOI Energy (verify current owner contact)
- Tender visibility: NONE

**Saras Sarroch (Sardinia)**
- 300 kbd, highest-complexity Mediterranean refinery
- Vitol JV announced 2024 — Vitol may now be the de facto crude
  procurement channel
- Outreach: Saras IR + Vitol crude desk
- Tender visibility: NONE

**Indian state refiners (IOCL Paradip, BPCL Kochi, MRPL Mangalore)**
- Combined 900+ kbd of complex coastal capacity
- Active spot tender buyers; Mediterranean sweets compete with Russian
  Urals and West African grades
- These are the rare PUBLIC-TENDER VISIBLE buyers for Libyan crude.
  Tenders publish on iocl.com / bpcl.com / mrpl.co.in e-tendering portals
- Outreach: respond to live tenders OR the trader desks at each
  state refiner
- **Action: when you can, build IOCL tender scraper to monitor real-time**

## Tier 2 — Plausible but secondary

**HelleniQ Energy (Greece)**
- 150 kbd Aspropyrgos + 100 kbd Elefsina
- Historical Libyan crude buyer; geographic adjacency
- Tender visibility: PARTIAL (some tenders via Greek e-procurement)

**MOL Százhalombatta (Hungary) + INA Rijeka (Croatia)**
- Inland Hungary + Adriatic coast; pivoting away from Russian Urals
  post-sanctions. Adria pipeline brings Mediterranean crude inland.
- Mediterranean sweets are a real candidate stream
- Outreach: MOL Group trading desk (Budapest)
- Tender visibility: NONE for crude

**OMV Schwechat (Austria)**
- 200 kbd, fed via Trans-Alpine from Trieste
- Outreach: OMV Trading (Vienna)
- Tender visibility: NONE

**TÜPRAŞ (Turkey, 4 refineries totaling ~660 kbd combined)**
- Heavy Russian crude diet historically; opportunity if Urals discount
  narrows. Largest sweet-crude takedown capacity in the region
- Outreach: TÜPRAŞ trading (Istanbul)
- Tender visibility: NONE

**Pertamina Cilacap (Indonesia)**
- 348 kbd, public-tender buyer
- Mediterranean sweets compete vs Saudi/Iraqi grades
- Tender visibility: PARTIAL (Pertamina tender portal)

## Tier 3 — Trading-house intermediated

You will likely close via a trading house, not a refiner direct, given
the volume and the broker's-broker structure. The crude desks worth
calling first:

- **Vitol** (Geneva/London) — biggest independent oil trader; active
  Libyan desk; their Saras JV gives them Italian refining take
- **Glencore** (Baar) — Mediterranean active; libya-historic
- **Trafigura** (Geneva/Singapore) — large crude book; mid-tier on
  Med spot but consistent
- **Mercuria** (Geneva) — opportunistic on Med sweets
- **Gunvor** (Geneva) — owns Rotterdam + Antwerp refineries; sweet
  desk active

Trading houses absorb the full cargo, take the price risk, and place
across their refiner relationships. Best path for fastest close.

## What is in the system

All Tier 1–3 entities seeded into `known_entities` and visible at
`/suppliers/known-entities`:

```
?category=crude-oil&tag=libya-historic   -- direct Libyan history
?category=crude-oil&tag=region:mediterranean   -- Mediterranean refiners
?category=crude-oil&tag=public-tender-visible   -- where tender scrapers help
?category=crude-oil&role=trader   -- trading houses
```

The supplier-graph queries (`find_buyers_for_offer`, `find_competing_sellers`)
will NOT surface these entities until/unless they appear in
public-tender award data. For now the rolodex is the right surface.

## What's missing (action items)

1. **Customs/AIS data subscription** — Kpler or Vortexa for one month.
   Single biggest unlock. Will show actual 2024–2025 Libyan offtakers
   by vessel/buyer/volume.
2. **IOCL India tender scraper** — public data, ~3 days of work to
   build. Adds real-time visibility into India\'s spot crude buying.
   Defer until current deal closes; it\'s an ongoing-deal asset, not
   a this-deal asset.
3. **Direct contact verification** — `contactEntity` field is empty
   for the seeded rows. Populate with named contacts as outreach
   conversations open.
4. **Recent flows** — Argus / Platts subscriptions show directional
   signals. Trade-press monitoring (RSS or curated digest) layered
   onto this rolodex would close the "is this buyer active right now"
   gap.

## Operational notes

- Eni's Libya relationship is the most defensible buyer thesis but
  also the hardest to break into — they have direct supply through
  Mellitah, they are not buying from independent brokers without a
  reason. Lead with relationship-style intro, not cold pitch.
- For Indian state refiners: bid into live tenders via a Singapore-
  registered trading entity. Direct broker calls don't work; the
  procurement protocol is bid-or-go-home.
- The trading houses are the highest-velocity exit. If Vitol/Glencore
  pass on the cargo at your offered level, that's strong signal the
  cargo is mispriced rather than a relationship issue.
