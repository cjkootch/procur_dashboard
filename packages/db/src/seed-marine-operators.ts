/**
 * Hand-curated seed for marine operators — the second wave of the
 * known_entities rolodex specifically for vessel-operating companies
 * we want EU MRV signals to roll up to.
 *
 * Per buyer-intelligence-v2-free-sources-brief.md §4.2, EU MRV
 * provides per-vessel verified annual fuel consumption (~5,000+ rows
 * for vessels > 5,000 GT calling at EU ports). To convert that into
 * useful operator-level demand signal, we need IMO → operator
 * mapping. Procur doesn't have a global IMO registry, so this seed
 * lays out ~30 operators procur cares about with empty
 * `metadata.fleet_imos` arrays — the analyst populates IMOs as deal
 * flow surfaces specific vessels, or via spot-checks against the
 * MRV file.
 *
 * Coverage is intentionally global (cruise, container, tanker, LNG,
 * LPG) — Caribbean fuel-buyer relevance comes from the Caribbean
 * cruise + container Caribbean-feeder operators in particular, but
 * tanker operators matter too for Caribbean off-take + product moves
 * out of Amuay/Cardón, ISLA, etc.
 *
 * Coverage in this seed:
 *   - Major cruise lines (cruise volume on Caribbean itineraries)
 *   - Top container lines (Caribbean trans-shipment via Kingston,
 *     Caucedo, Freeport, MIT/Manzanillo, Cartagena)
 *   - Crude tanker operators (specialty crude movement)
 *   - Product tanker operators (refined-product trade flows)
 *   - LPG/LNG operators (gas trade)
 *   - Caribbean-specialist feeder operators (Crowley, Tropical, Seaboard)
 *
 * Facts here are restricted to publicly-known basics (HQ country,
 * segment, public domain). Approximate fleet sizes are noted where
 * confidently known. No invented contact details. Empty fleet_imos
 * — those land via post-seed curation against the MRV file.
 *
 * Idempotent: upserts on slug.
 *
 * Run from repo root:
 *   pnpm --filter @procur/db seed-marine-operators
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { sql, type SQL } from 'drizzle-orm';
import { db } from './client';

// Drizzle's neon-http driver treats a raw JS array param as a record,
// which produces `cannot cast type record to text[]`. Build a real
// `ARRAY[...]::text[]` (or `'{}'::text[]` when empty) so each element
// flows in as its own bound parameter.
function textArray(values: string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type MarineOperatorSeed = {
  slug: string;
  name: string;
  country: string;
  segment: 'cruise' | 'container' | 'tanker-crude' | 'tanker-product' | 'lpg' | 'lng' | 'mixed';
  primaryDomain: string | null;
  notes: string;
  aliases?: string[];
  /** Publicly-known approximate vessel count, where confidently known. */
  fleetSize?: number;
};

const OPERATORS: MarineOperatorSeed[] = [
  // ─── Cruise — Caribbean is the largest cruise market globally ────
  {
    slug: 'fuel-buyer:royal-caribbean-group',
    name: 'Royal Caribbean Group',
    country: 'US',
    segment: 'cruise',
    primaryDomain: 'royalcaribbeangroup.com',
    notes:
      'Royal Caribbean International + Celebrity Cruises + Silversea. ' +
      'NYSE: RCL. Single largest Caribbean-itinerary cruise operator; ' +
      'Miami-headquartered with multi-vessel Caribbean homeport rotation.',
    aliases: ['Royal Caribbean', 'RCL', 'RCCL'],
  },
  {
    slug: 'fuel-buyer:carnival-corporation',
    name: 'Carnival Corporation',
    country: 'US',
    segment: 'cruise',
    primaryDomain: 'carnivalcorp.com',
    notes:
      'Multi-brand: Carnival Cruise Line + Princess + Holland America + ' +
      'Costa + AIDA + Cunard + P&O. NYSE: CCL. ~85+ vessels globally; ' +
      'Caribbean is the highest-frequency itinerary region.',
    aliases: ['Carnival Corp', 'CCL'],
  },
  {
    slug: 'fuel-buyer:norwegian-cruise-line-holdings',
    name: 'Norwegian Cruise Line Holdings',
    country: 'BM',
    segment: 'cruise',
    primaryDomain: 'nclhltd.com',
    notes:
      'NCL + Oceania + Regent Seven Seas. NYSE: NCLH. Bermuda-incorporated, ' +
      'Miami-operated. Caribbean + Alaska + Med are the three core markets.',
    aliases: ['NCL', 'NCLH'],
  },
  {
    slug: 'fuel-buyer:msc-cruises',
    name: 'MSC Cruises',
    country: 'CH',
    segment: 'cruise',
    primaryDomain: 'msccruises.com',
    notes:
      'Subsidiary of MSC Group (Aponte family). Private. Geneva-' +
      'headquartered; rapid Caribbean expansion via Ocean Cay private island.',
    aliases: ['MSC'],
  },
  {
    slug: 'fuel-buyer:disney-cruise-line',
    name: 'Disney Cruise Line',
    country: 'US',
    segment: 'cruise',
    primaryDomain: 'disneycruise.disney.go.com',
    notes:
      'Wholly-owned by The Walt Disney Company. Caribbean / Bahamas the ' +
      'core itinerary mix; Castaway Cay private island.',
    aliases: ['Disney Cruise', 'DCL'],
  },

  // ─── Container — Caribbean transshipment hubs route global volume ─
  {
    slug: 'fuel-buyer:msc-mediterranean-shipping',
    name: 'MSC Mediterranean Shipping Company',
    country: 'CH',
    segment: 'container',
    primaryDomain: 'msc.com',
    notes:
      'Largest container operator globally by TEU capacity (~6M TEU, ' +
      '800+ vessels). Private. Caribbean transshipment via Freeport ' +
      'Container Port (Bahamas) + others.',
    aliases: ['MSC Container', 'Mediterranean Shipping'],
  },
  {
    slug: 'fuel-buyer:maersk',
    name: 'A.P. Moller — Maersk',
    country: 'DK',
    segment: 'container',
    primaryDomain: 'maersk.com',
    notes:
      'Copenhagen: MAERSK-B. ~700+ container vessels. Major Caribbean ' +
      'transshipment via APM Terminals Moin (Costa Rica) + APM Algeciras.',
    aliases: ['Maersk', 'A.P. Moller', 'AP Moller'],
  },
  {
    slug: 'fuel-buyer:cma-cgm',
    name: 'CMA CGM',
    country: 'FR',
    segment: 'container',
    primaryDomain: 'cma-cgm.com',
    notes:
      'Marseille-headquartered. Saadé family controlled (private). Top-3 ' +
      'global container line. Caribbean Caucedo + Kingston rotations.',
    aliases: ['CMA CGM Group'],
  },
  {
    slug: 'fuel-buyer:hapag-lloyd',
    name: 'Hapag-Lloyd',
    country: 'DE',
    segment: 'container',
    primaryDomain: 'hapag-lloyd.com',
    notes:
      'Hamburg-headquartered. Frankfurt: HLAG. ~270 vessel fleet. CCL ' +
      '(Caribbean-Central America loop) + GS3 / GS4 services touch ' +
      'Caribbean ports.',
  },
  {
    slug: 'fuel-buyer:evergreen-marine',
    name: 'Evergreen Marine',
    country: 'TW',
    segment: 'container',
    primaryDomain: 'evergreen-marine.com',
    notes:
      'Taipei. TWSE: 2603. ~200+ vessels. Major Caribbean trans-Pacific ' +
      'feeder via Manzanillo (PA) + Caucedo.',
    aliases: ['Evergreen', 'Evergreen Line'],
  },
  {
    slug: 'fuel-buyer:cosco-shipping-holdings',
    name: 'COSCO Shipping Holdings',
    country: 'CN',
    segment: 'container',
    primaryDomain: 'lines.coscoshipping.com',
    notes:
      'Shanghai-headquartered state-owned. HKEX: 1919. Subsidiaries OOCL + ' +
      'COSCO Lines. Caribbean services include CES + CSAT loops.',
    aliases: ['COSCO', 'COSCO SHIPPING'],
  },
  {
    slug: 'fuel-buyer:zim-integrated-shipping',
    name: 'ZIM Integrated Shipping Services',
    country: 'IL',
    segment: 'container',
    primaryDomain: 'zim.com',
    notes:
      'Haifa. NYSE: ZIM. Asset-light operator (mostly chartered). ZCA + ' +
      'ZIM Caribbean services rotate Kingston + Caucedo + Freeport.',
    aliases: ['ZIM'],
  },

  // ─── Crude tankers — Caribbean off-take + Vector Antilles flow ────
  {
    slug: 'fuel-buyer:frontline',
    name: 'Frontline plc',
    country: 'CY',
    segment: 'tanker-crude',
    primaryDomain: 'frontlineplc.cy',
    notes:
      'Cyprus-domiciled, Oslo + NYSE listed (FRO). VLCC + Suezmax + LR2 ' +
      'fleet — formerly Fredriksen-controlled. Major Atlantic basin and ' +
      'TD22 (USGC → China) crude flows.',
    aliases: ['Frontline'],
  },
  {
    slug: 'fuel-buyer:dht-holdings',
    name: 'DHT Holdings',
    country: 'BM',
    segment: 'tanker-crude',
    primaryDomain: 'dhtankers.com',
    notes:
      'Bermuda-domiciled, Oslo office. NYSE: DHT. Pure VLCC operator (~24 ' +
      'vessels). Atlantic basin crude long-haul.',
    aliases: ['DHT'],
  },
  {
    slug: 'fuel-buyer:international-seaways',
    name: 'International Seaways',
    country: 'US',
    segment: 'tanker-crude',
    primaryDomain: 'intlseas.com',
    notes:
      'NYC-headquartered. NYSE: INSW. Mixed VLCC + Suezmax + LR1/MR fleet ' +
      'after Diamond S merger (2021). Active in TD22 + USGC product flows.',
    aliases: ['Seaways', 'INSW'],
  },

  // ─── Product tankers — refined-product flow into Caribbean ────────
  {
    slug: 'fuel-buyer:hafnia',
    name: 'Hafnia Limited',
    country: 'BM',
    segment: 'tanker-product',
    primaryDomain: 'hafniabw.com',
    notes:
      'Bermuda-domiciled, BW Group + public. Oslo: HAFNI. Largest product ' +
      'tanker pool operator globally (~200 vessels via Hafnia + pools). ' +
      'Caribbean refined-product distribution coverage strong.',
    aliases: ['Hafnia', 'BW Hafnia'],
  },
  {
    slug: 'fuel-buyer:ardmore-shipping',
    name: 'Ardmore Shipping',
    country: 'IE',
    segment: 'tanker-product',
    primaryDomain: 'ardmoreshipping.com',
    notes:
      'Cork, Ireland. NYSE: ASC. ~25 MR/LR1 product tankers. ' +
      'Atlantic basin refined-product flows including Caribbean.',
  },
  {
    slug: 'fuel-buyer:stena-bulk',
    name: 'Stena Bulk',
    country: 'SE',
    segment: 'tanker-product',
    primaryDomain: 'stenabulk.com',
    notes:
      'Gothenburg. Stena Sphere private subsidiary. ~80 product + ' +
      'chemical tankers. IMOIIMAX class plus crude vessels.',
    aliases: ['Stena'],
  },
  {
    slug: 'fuel-buyer:torm',
    name: 'TORM plc',
    country: 'GB',
    segment: 'tanker-product',
    primaryDomain: 'torm.com',
    notes:
      'London + Copenhagen. Nasdaq Copenhagen + Nasdaq US: TRMD. ~80 ' +
      'product tankers (LR1 + MR). Atlantic basin refined-product specialist.',
  },
  {
    slug: 'fuel-buyer:scorpio-tankers',
    name: 'Scorpio Tankers',
    country: 'MC',
    segment: 'tanker-product',
    primaryDomain: 'scorpiotankers.com',
    notes:
      'Monaco-headquartered. NYSE: STNG. ~110 product tankers (LR2 + LR1 ' +
      '+ MR + Handymax). Largest pure-play product tanker operator.',
    aliases: ['Scorpio', 'STNG'],
  },
  {
    slug: 'fuel-buyer:damico-international-shipping',
    name: 'd\'Amico International Shipping',
    country: 'LU',
    segment: 'tanker-product',
    primaryDomain: 'damicointernationalshipping.com',
    notes:
      'Luxembourg domiciled, Italian-controlled. Borsa Italiana: DIS. ' +
      'Product tanker fleet ~30 vessels.',
    aliases: ['DIS', 'd\'Amico'],
  },

  // ─── LPG / LNG — gas trade Atlantic basin ─────────────────────────
  {
    slug: 'fuel-buyer:bw-lpg',
    name: 'BW LPG',
    country: 'BM',
    segment: 'lpg',
    primaryDomain: 'bwlpg.com',
    notes:
      'Bermuda-domiciled, Singapore office. Oslo: BWLPG. ~50 VLGC. ' +
      'World\'s largest VLGC operator.',
  },
  {
    slug: 'fuel-buyer:dorian-lpg',
    name: 'Dorian LPG',
    country: 'US',
    segment: 'lpg',
    primaryDomain: 'dorianlpg.com',
    notes:
      'Connecticut. NYSE: LPG. ~25 VLGC. US LPG export from USGC to Asia ' +
      'is the dominant route.',
  },
  {
    slug: 'fuel-buyer:flex-lng',
    name: 'Flex LNG',
    country: 'BM',
    segment: 'lng',
    primaryDomain: 'flexlng.com',
    notes:
      'Bermuda-domiciled, Oslo + NYSE: FLNG. ~13 LNG carriers. ' +
      'Fredriksen-affiliated.',
  },

  // ─── Caribbean specialists ────────────────────────────────────────
  {
    slug: 'fuel-buyer:crowley-maritime',
    name: 'Crowley Maritime',
    country: 'US',
    segment: 'mixed',
    primaryDomain: 'crowley.com',
    notes:
      'Jacksonville, FL. Private. Caribbean-focused mixed fleet — Puerto ' +
      'Rico Jones-Act trade dominant + Central America + offshore + ' +
      'product tanker arm.',
  },
  {
    slug: 'fuel-buyer:tropical-shipping',
    name: 'Tropical Shipping',
    country: 'US',
    segment: 'container',
    primaryDomain: 'tropical.com',
    notes:
      'West Palm Beach. Subsidiary of Saltchuk. Caribbean-only container ' +
      'feeder; ~20 vessels covering 25 Caribbean ports from US east coast.',
  },
  {
    slug: 'fuel-buyer:seaboard-marine',
    name: 'Seaboard Marine',
    country: 'US',
    segment: 'container',
    primaryDomain: 'seaboardmarine.com',
    notes:
      'Miami. Subsidiary of Seaboard Corp (NYSEAM: SEB). Caribbean + ' +
      'Central America container service; primary US-Caribbean feeder ' +
      'competitor to Tropical.',
  },
];

const SEGMENT_TO_TAGS: Record<MarineOperatorSeed['segment'], string[]> = {
  cruise: ['marine-operator', 'segment:cruise'],
  container: ['marine-operator', 'segment:container'],
  'tanker-crude': ['marine-operator', 'segment:tanker', 'tanker:crude'],
  'tanker-product': ['marine-operator', 'segment:tanker', 'tanker:product'],
  lpg: ['marine-operator', 'segment:lpg'],
  lng: ['marine-operator', 'segment:lng'],
  mixed: ['marine-operator', 'segment:mixed'],
};

const SEGMENT_TO_CATEGORIES: Record<MarineOperatorSeed['segment'], string[]> = {
  // Cruise lines burn HFO/MGO blend with low-sulfur regs since IMO 2020 —
  // procur category tagging targets the procurement side (what they buy
  // from us), not what they burn.
  cruise: ['heavy-fuel-oil', 'diesel', 'lpg'],
  container: ['heavy-fuel-oil', 'diesel'],
  'tanker-crude': ['heavy-fuel-oil', 'diesel'],
  'tanker-product': ['heavy-fuel-oil', 'diesel'],
  lpg: ['heavy-fuel-oil', 'diesel', 'lpg'],
  lng: ['heavy-fuel-oil', 'diesel', 'lng'],
  mixed: ['heavy-fuel-oil', 'diesel'],
};

async function main(): Promise<void> {
  console.log(`Seeding ${OPERATORS.length} marine operators…`);
  let upserted = 0;
  const errors: string[] = [];

  for (const op of OPERATORS) {
    const tags = SEGMENT_TO_TAGS[op.segment];
    const categories = SEGMENT_TO_CATEGORIES[op.segment];
    const aliases = op.aliases ?? [];

    // metadata.fleet_imos lands empty — analyst populates from MRV
    // cross-reference. metadata.segment + fleet_size_approx for UI.
    const metadata = {
      segment: op.segment,
      fleet_size_approx: op.fleetSize ?? null,
      fleet_imos: [] as string[],
    };

    try {
      await db.execute(sql`
        INSERT INTO known_entities (
          slug, name, country, role, categories, notes, aliases, tags,
          primary_domain, metadata
        ) VALUES (
          ${op.slug}, ${op.name}, ${op.country}, 'marine-operator',
          ${textArray(categories)}, ${op.notes},
          ${textArray(aliases)}, ${textArray(tags)},
          ${op.primaryDomain},
          ${JSON.stringify(metadata)}::jsonb
        )
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          country = EXCLUDED.country,
          role = EXCLUDED.role,
          categories = EXCLUDED.categories,
          notes = EXCLUDED.notes,
          aliases = EXCLUDED.aliases,
          tags = EXCLUDED.tags,
          primary_domain = EXCLUDED.primary_domain,
          -- preserve any analyst-curated fleet_imos already populated;
          -- only fill in null / missing pieces of metadata
          metadata = COALESCE(known_entities.metadata, '{}'::jsonb) || ${JSON.stringify(
            { segment: op.segment, fleet_size_approx: op.fleetSize ?? null },
          )}::jsonb,
          updated_at = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`${op.slug}: ${(err as Error).message}`);
    }
  }

  console.log(`  upserted ${upserted}/${OPERATORS.length} operators`);
  if (errors.length > 0) {
    console.error('Errors:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
