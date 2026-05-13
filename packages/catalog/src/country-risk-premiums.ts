/**
 * Country-risk premium ($/USG) for high-risk corridors.
 *
 * The `realisticCifUsdPer*.high` returned by `evaluateTargetPrice`
 * is a textbook upper bound — Brent + max crack + freight-high +
 * seller margin. That's right for normal efficient markets
 * (Rotterdam, Singapore, Houston→WAF) but systematically
 * under-prices the achievable CIF in corridors where one or more
 * of these is true:
 *
 *   - Security or political instability disrupts logistics
 *   - Sanctions adjacency limits the supplier pool willing to deliver
 *   - Civil unrest / gang activity at the discharge terminal
 *   - Post-disaster supply tightness
 *   - The market is too small for major-trader competition, leaving
 *     incumbents with pricing power
 *
 * The premium below stacks ON TOP of the textbook `high` to produce
 * a `highWithCountryRisk` ceiling that captures these dynamics.
 *
 * Discipline:
 *   - Values are conservative analyst estimates. Tighten over time
 *     as real importer pricing surfaces in customs / regulator data.
 *   - Adding a country here is a deliberate analyst decision; it's
 *     not auto-generated from any risk score.
 *   - Premium applies on top of the textbook high — the low and mid
 *     stay unchanged so existing plausibility verdicts aren't
 *     skewed.
 *   - For sanctioned countries (CU, IR, KP, SY, VE) we deliberately
 *     do NOT publish a premium here — those flows shouldn't be
 *     modeled in procur at all. Use `excludedJurisdictions` on deal
 *     structure templates to enforce.
 */

export type CountryRiskPremium = {
  /** ISO-2 country code (uppercase). */
  countryCode: string;
  /** $/USG added on top of the textbook `realisticCifUsdPerUsg.high`. */
  premiumUsdPerUsg: number;
  /** Why this corridor commands a premium — surfaced in tool output
   *  so the operator (and the assistant) can explain the math. */
  reason: string;
  /** Which product families this applies to. 'all' is the default. */
  scope: 'all' | 'refined' | 'crude';
};

export const COUNTRY_RISK_PREMIUMS: Record<string, CountryRiskPremium> = {
  HT: {
    countryCode: 'HT',
    premiumUsdPerUsg: 0.30,
    reason:
      'Haiti — gang-controlled fuel terminals at Port-au-Prince, repeated 2024-25 port closures, very limited supplier pool willing to commit cargoes. Buyers historically accept $0.25-0.40/USG over textbook CIF for delivery reliability.',
    scope: 'all',
  },
  SO: {
    countryCode: 'SO',
    premiumUsdPerUsg: 0.30,
    reason:
      'Somalia — security risk at Mogadishu / Berbera, piracy-zone war-risk insurance overlay, thin supplier pool. Aviation-grade kerosene corridor especially constrained.',
    scope: 'all',
  },
  LY: {
    countryCode: 'LY',
    premiumUsdPerUsg: 0.20,
    reason:
      'Libya — port disruption at Tripoli / Misurata during NOC vs. eastern-government disputes, sanctions adjacency, war-risk premium routinely applied on hulls.',
    scope: 'all',
  },
  YE: {
    countryCode: 'YE',
    premiumUsdPerUsg: 0.35,
    reason:
      'Yemen — Houthi-controlled Hodeidah, Saudi-coalition inspection regime adds laytime risk, very limited supplier engagement. Aden side more tractable but premium still applies.',
    scope: 'all',
  },
  SS: {
    countryCode: 'SS',
    premiumUsdPerUsg: 0.25,
    reason:
      'South Sudan — landlocked delivery via Mombasa overland, security on Juba road corridor, very thin supplier base.',
    scope: 'all',
  },
  SD: {
    countryCode: 'SD',
    premiumUsdPerUsg: 0.30,
    reason:
      'Sudan — Port Sudan operating under active conflict, RSF/SAF dispute affecting clearance, supplier reluctance post-2023.',
    scope: 'all',
  },
  CD: {
    countryCode: 'CD',
    premiumUsdPerUsg: 0.18,
    reason:
      'DRC — Matadi/Boma port congestion, inland transport security (Kivu, Ituri) factored into delivered pricing. Pure CIF less affected; DDP carries the full premium.',
    scope: 'all',
  },
  ML: {
    countryCode: 'ML',
    premiumUsdPerUsg: 0.25,
    reason:
      'Mali — landlocked via Abidjan / Dakar; Sahel security on the road corridor; ECOWAS sanction history adds counterparty caution.',
    scope: 'refined',
  },
  BF: {
    countryCode: 'BF',
    premiumUsdPerUsg: 0.22,
    reason:
      'Burkina Faso — same Sahel corridor risk as Mali, post-2022 coup instability, narrowed supplier engagement.',
    scope: 'refined',
  },
  NE: {
    countryCode: 'NE',
    premiumUsdPerUsg: 0.25,
    reason:
      'Niger — ECOWAS sanctions adjacency 2023-24, supplier withdrawal, landlocked via Cotonou with overland security risk.',
    scope: 'refined',
  },
  MM: {
    countryCode: 'MM',
    premiumUsdPerUsg: 0.22,
    reason:
      'Myanmar — military-government counterparty risk, OFAC enhanced due diligence post-2021, narrowed major-trader engagement.',
    scope: 'all',
  },
  LB: {
    countryCode: 'LB',
    premiumUsdPerUsg: 0.15,
    reason:
      'Lebanon — Beirut port supply tightness post-2020, banking sector / payment risk, periodic Hezbollah-adjacent sanctions concerns affecting supplier engagement.',
    scope: 'all',
  },
  AF: {
    countryCode: 'AF',
    premiumUsdPerUsg: 0.35,
    reason:
      'Afghanistan — Taliban-government counterparty risk, OFAC sanctions adjacency, no major-trader competition. Most flows via Iran / Turkmenistan overland, narrow CIF window.',
    scope: 'all',
  },
};

/**
 * Look up the country-risk premium for a destination country.
 *
 * @param countryCode ISO-2, case-insensitive.
 * @param product 'refined' or 'crude' — some premiums are scoped
 *                (e.g. Sahel premiums apply to refined product
 *                deliveries but not to crude exports from those
 *                countries).
 * @returns the premium entry, or null if no premium applies.
 */
export function getCountryRiskPremium(
  countryCode: string | null | undefined,
  product: 'refined' | 'crude',
): CountryRiskPremium | null {
  if (!countryCode) return null;
  const entry = COUNTRY_RISK_PREMIUMS[countryCode.toUpperCase()];
  if (!entry) return null;
  if (entry.scope === 'all') return entry;
  if (entry.scope === product) return entry;
  return null;
}
