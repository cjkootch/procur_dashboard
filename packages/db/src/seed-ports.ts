/**
 * Seed the ports geofence dictionary.
 *
 * Coverage priority: Libyan crude-loading terminals (the active deal),
 * Mediterranean refinery ports (Tier-1/2 buyer pool from
 * libyan-crude-buyer-brief.md), Indian refinery ports (Tier-1
 * spot-tender buyers), and a handful of major transshipment hubs.
 *
 * Coordinates are approximate (terminal centroid). geofence_radius_nm
 * is set per-port: tight terminals = 1.5–2 nm; broader anchorage
 * areas = 4–5 nm. Refine as port-call inference reveals false
 * positives / negatives.
 *
 * Re-seed safe (ON CONFLICT). Add ports by appending here + opening
 * a PR.
 *
 * Run: pnpm --filter @procur/db seed-ports
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

loadEnv({ path: '../../.env.local' });
loadEnv({ path: '../../.env' });

type PortSeed = {
  slug: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  radiusNm: number;
  portType: 'crude-loading' | 'refinery' | 'transshipment' | 'mixed';
  knownGrades?: string[];
  linkedEntitySlug?: string | null;
  notes?: string;
};

const PORTS: PortSeed[] = [
  // ── Libyan crude-loading terminals ─────────────────────────
  {
    slug: 'es-sider',
    name: 'Es Sider Terminal',
    country: 'LY',
    lat: 30.6433,
    lng: 18.3667,
    radiusNm: 4,
    portType: 'crude-loading',
    knownGrades: ['es-sider', 'sirtica'],
    notes: 'Largest Libyan crude export terminal. Sirte basin.',
  },
  {
    slug: 'ras-lanuf',
    name: 'Ras Lanuf Terminal',
    country: 'LY',
    lat: 30.5167,
    lng: 18.5833,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['es-sider', 'sirtica'],
    notes: 'Sirte basin loading terminal.',
  },
  {
    slug: 'marsa-el-brega',
    name: 'Marsa El Brega Terminal',
    country: 'LY',
    lat: 30.4083,
    lng: 19.5800,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['brega'],
    notes: 'Brega grade loading terminal.',
  },
  {
    slug: 'marsa-el-hariga',
    name: 'Marsa El Hariga Terminal',
    country: 'LY',
    lat: 32.0833,
    lng: 23.9833,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['es-sider', 'sirtica'],
    notes: 'Tobruk-area terminal — Eastern Libya control.',
  },
  {
    slug: 'zueitina',
    name: 'Zueitina Terminal',
    country: 'LY',
    lat: 30.8881,
    lng: 20.0625,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['es-sider'],
  },
  {
    slug: 'zawiya',
    name: 'Zawiya Terminal',
    country: 'LY',
    lat: 32.7833,
    lng: 12.7333,
    radiusNm: 3,
    portType: 'mixed',
    knownGrades: ['sharara'],
    notes: 'Sharara grade loads here. Also Zawiya refinery — both inbound + outbound.',
  },
  {
    slug: 'mellitah',
    name: 'Mellitah Terminal',
    country: 'LY',
    lat: 33.0167,
    lng: 11.8500,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['bouri'],
    notes: 'Eni-operated via Mellitah Oil & Gas. Bouri offshore field crude.',
  },

  // ── Algerian terminals (Sonatrach export complex) ─────────
  {
    slug: 'skikda-terminal',
    name: 'Skikda Terminal',
    country: 'DZ',
    lat: 36.92,
    lng: 6.96,
    radiusNm: 3,
    portType: 'mixed',
    knownGrades: ['saharan-blend', 'algerian-condensate'],
    linkedEntitySlug: 'curated-dz-sonatrach-skikda',
    notes:
      "Algeria's primary crude + product export complex. Co-located with Sonatrach Skikda 350 kbd refinery + LNG. Saharan Blend exits via Bejaia pipeline → Skikda or direct from In Amenas → Skikda.",
  },
  {
    slug: 'arzew-terminal',
    name: 'Arzew Terminal',
    country: 'DZ',
    lat: 35.83,
    lng: -0.30,
    radiusNm: 3,
    portType: 'mixed',
    knownGrades: ['saharan-blend', 'algerian-condensate'],
    linkedEntitySlug: 'curated-dz-sonatrach-arzew',
    notes:
      'Algeria\'s second-largest export hub. LNG complex + ~60 kbd Sonatrach refinery + crude/condensate loading. Western basin output flows here.',
  },
  {
    slug: 'bejaia-terminal',
    name: 'Bejaia Terminal',
    country: 'DZ',
    lat: 36.77,
    lng: 5.08,
    radiusNm: 3,
    portType: 'crude-loading',
    knownGrades: ['saharan-blend'],
    notes:
      'Pipeline terminus from Hassi Messaoud field. Loads Saharan Blend crude for export. Smaller than Skikda but a primary crude-only outlet.',
  },
  {
    slug: 'oran-port',
    name: 'Oran Commercial Port',
    country: 'DZ',
    lat: 35.71,
    lng: -0.65,
    radiusNm: 2,
    portType: 'mixed',
    notes:
      'Commercial port handling general cargo + some refined product imports. Less crude-focused than Skikda/Arzew/Bejaia; mainly diesel/gasoline product calls.',
  },

  // ── Italian refinery ports (Tier 1 buyers) ────────────────
  {
    slug: 'sannazzaro-refinery',
    name: 'Sannazzaro de Burgondi Refinery',
    country: 'IT',
    lat: 45.0850,
    lng: 8.9317,
    radiusNm: 1.5,
    portType: 'refinery',
    notes: 'Eni Sannazzaro — inland refinery; pipeline-fed from Genoa terminal.',
  },
  {
    slug: 'genoa-port',
    name: 'Genoa Oil Terminal',
    country: 'IT',
    lat: 44.4060,
    lng: 8.9268,
    radiusNm: 4,
    portType: 'refinery',
    notes: 'Genoa multedo terminal — feeds Sannazzaro refinery via pipeline.',
  },
  {
    slug: 'taranto-refinery',
    name: 'Taranto Refinery Port',
    country: 'IT',
    lat: 40.4500,
    lng: 17.2167,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Eni Taranto refinery — direct seaborne intake.',
  },
  {
    slug: 'sarroch-port',
    name: 'Sarroch (Saras Refinery)',
    country: 'IT',
    lat: 39.0717,
    lng: 9.0181,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Saras Sarroch — Sardinia. Highest-complexity Med refinery.',
  },
  {
    slug: 'augusta-port',
    name: 'Augusta Refinery Port',
    country: 'IT',
    lat: 37.2400,
    lng: 15.2200,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Sicily — Sonatrach Augusta + Sasol Augusta + Esso Augusta cluster.',
  },
  {
    slug: 'milazzo-port',
    name: 'Milazzo Refinery Port',
    country: 'IT',
    lat: 38.2200,
    lng: 15.2400,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Eni-Kuwait Petroleum JV (RAM).',
  },
  {
    slug: 'trieste-port',
    name: 'Trieste Oil Port (TAL pipeline)',
    country: 'IT',
    lat: 45.6486,
    lng: 13.7831,
    radiusNm: 3,
    portType: 'mixed',
    notes: 'TAL pipeline head — feeds Schwechat (AT), Karlsruhe + Burghausen (DE), Kralupy (CZ).',
  },

  // ── Spanish refinery ports (Tier 1) ───────────────────────
  {
    slug: 'cartagena-port',
    name: 'Cartagena Refinery Port',
    country: 'ES',
    lat: 37.5947,
    lng: -1.0050,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Repsol Cartagena — full-conversion complex.',
  },
  {
    slug: 'bilbao-port',
    name: 'Bilbao (Petronor) Port',
    country: 'ES',
    lat: 43.3700,
    lng: -3.0900,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Repsol Petronor (Muskiz).',
  },
  {
    slug: 'tarragona-port',
    name: 'Tarragona Refinery Port',
    country: 'ES',
    lat: 41.0950,
    lng: 1.2350,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Repsol Tarragona.',
  },

  // ── French refinery ports ─────────────────────────────────
  {
    slug: 'fos-lavera-port',
    name: 'Fos / Lavéra Oil Port',
    country: 'FR',
    lat: 43.3833,
    lng: 4.9667,
    radiusNm: 4,
    portType: 'refinery',
    notes: 'TotalEnergies La Mède + Petroineos (Lavéra) — Marseille-Fos cluster.',
  },

  // ── Greek refinery ports (Tier 2) ─────────────────────────
  {
    slug: 'aspropyrgos-port',
    name: 'Aspropyrgos Refinery Port',
    country: 'GR',
    lat: 38.0389,
    lng: 23.5883,
    radiusNm: 2,
    portType: 'refinery',
    notes: 'HelleniQ Aspropyrgos.',
  },
  {
    slug: 'elefsina-port',
    name: 'Elefsina Refinery Port',
    country: 'GR',
    lat: 38.0381,
    lng: 23.5278,
    radiusNm: 2,
    portType: 'refinery',
    notes: 'HelleniQ Elefsina — full-conversion complex.',
  },
  {
    slug: 'corinth-port',
    name: 'Corinth (Motor Oil) Refinery Port',
    country: 'GR',
    lat: 37.9508,
    lng: 22.9233,
    radiusNm: 2,
    portType: 'refinery',
    notes: 'Motor Oil Hellas — Greece\'s second major refiner.',
  },

  // ── Turkish refinery ports (Tier 2) ───────────────────────
  {
    slug: 'izmit-port',
    name: 'İzmit (TÜPRAŞ) Refinery Port',
    country: 'TR',
    lat: 40.7600,
    lng: 29.9100,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'TÜPRAŞ İzmit — flagship Turkish refinery.',
  },
  {
    slug: 'aliaga-port',
    name: 'Aliağa (TÜPRAŞ İzmir) Port',
    country: 'TR',
    lat: 38.7950,
    lng: 26.9472,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'TÜPRAŞ İzmir.',
  },
  {
    slug: 'ceyhan-port',
    name: 'Ceyhan (BTC + ITP terminus)',
    country: 'TR',
    lat: 36.8617,
    lng: 35.9258,
    radiusNm: 4,
    portType: 'mixed',
    knownGrades: ['azeri-light', 'kirkuk'],
    notes: 'BTC pipeline (Azeri Light) + Iraq–Türkiye pipeline (Kirkuk) terminus.',
  },

  // ── Israeli refinery ports ───────────────────────────────
  {
    slug: 'ashdod-port',
    name: 'Ashdod Refinery Port',
    country: 'IL',
    lat: 31.8000,
    lng: 34.6333,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Paz Ashdod refinery.',
  },
  {
    slug: 'haifa-port',
    name: 'Haifa Refinery Port',
    country: 'IL',
    lat: 32.8200,
    lng: 35.0000,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'Bazan Haifa refinery.',
  },

  // ── Indian refinery ports (Tier 1 spot-tender buyers) ────
  {
    slug: 'paradip-port',
    name: 'Paradip Refinery Port',
    country: 'IN',
    lat: 20.2800,
    lng: 86.6700,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'IOCL Paradip.',
  },
  {
    slug: 'kochi-port',
    name: 'Kochi Refinery Port',
    country: 'IN',
    lat: 9.9667,
    lng: 76.2400,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'BPCL Kochi.',
  },
  {
    slug: 'mangalore-port',
    name: 'Mangalore Refinery Port',
    country: 'IN',
    lat: 12.9100,
    lng: 74.7900,
    radiusNm: 3,
    portType: 'refinery',
    notes: 'MRPL Mangalore.',
  },
  {
    slug: 'jamnagar-port',
    name: 'Jamnagar (Reliance) Refinery Port',
    country: 'IN',
    lat: 22.3500,
    lng: 69.5500,
    radiusNm: 4,
    portType: 'refinery',
    notes: 'Reliance Jamnagar — world\'s largest single-site refinery (~1.4 mbd).',
  },

  // ── Major transshipment / STS hubs ───────────────────────
  {
    slug: 'gibraltar-strait-anchorage',
    name: 'Gibraltar Strait Anchorage',
    country: 'GI',
    lat: 36.1500,
    lng: -5.3500,
    radiusNm: 5,
    portType: 'transshipment',
    notes: 'STS lightering + bunker cluster — flagship Med STS area.',
  },
  {
    slug: 'cyprus-stss',
    name: 'Cyprus STS Anchorage',
    country: 'CY',
    lat: 34.4000,
    lng: 33.5000,
    radiusNm: 5,
    portType: 'transshipment',
    notes: 'East-Med STS hub — heavy Russian-crude transshipment activity post-sanctions.',
  },
  {
    slug: 'fujairah-port',
    name: 'Fujairah Anchorage',
    country: 'AE',
    lat: 25.1300,
    lng: 56.4000,
    radiusNm: 6,
    portType: 'transshipment',
    notes: 'Persian Gulf transshipment + bunker hub. Iran-sanctions adjacent.',
  },
  {
    slug: 'rotterdam-port',
    name: 'Rotterdam Oil Port',
    country: 'NL',
    lat: 51.9500,
    lng: 4.0833,
    radiusNm: 5,
    portType: 'mixed',
    notes: 'Europort — largest European refining/transshipment hub. Vitol, Vopak terminals.',
  },

  // ── West Africa ────────────────────────────────────────────
  // Coverage for the Atlantic-coast bbox (PR #289). Without these
  // seeded, vessel positions in the new bbox have no port to
  // attribute calls to and the entity Vessel Activity sections
  // stay empty.
  {
    slug: 'tema-port',
    name: 'Tema Oil Refinery Port',
    country: 'GH',
    lat: 5.6386,
    lng: -0.0181,
    radiusNm: 4,
    portType: 'refinery',
    notes:
      'Tema (TOR) — Ghana\'s only refinery, ~45 kbd. Primary West Africa import hub for refined products.',
  },
  {
    slug: 'lome-port',
    name: 'Port of Lomé',
    country: 'TG',
    lat: 6.1319,
    lng: 1.2873,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Togo\'s deepwater port — regional transshipment for landlocked Sahel + bunker hub for West Africa coastal trade.',
  },
  {
    slug: 'lagos-apapa-port',
    name: 'Lagos / Apapa Oil Port',
    country: 'NG',
    lat: 6.4434,
    lng: 3.3623,
    radiusNm: 5,
    portType: 'mixed',
    notes:
      'Apapa terminal complex — Nigeria\'s primary refined-product import gateway. Adjacent to Dangote\'s Lekki port.',
  },
  {
    slug: 'lekki-port',
    name: 'Lekki Deep Sea Port (Dangote)',
    country: 'NG',
    lat: 6.4500,
    lng: 3.7000,
    radiusNm: 4,
    portType: 'refinery',
    notes:
      'Dangote Refinery offshore terminal — 650 kbd refinery (world\'s largest single-train), commissioned 2024. Crude in / refined products out.',
  },
  {
    slug: 'dakar-port',
    name: 'Port of Dakar',
    country: 'SN',
    lat: 14.6928,
    lng: -17.4467,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Dakar — Senegal\'s primary port, hosts SAR (Société Africaine de Raffinage, ~27 kbd). West Africa bunkering hub.',
  },
  {
    slug: 'cabinda-terminal',
    name: 'Cabinda Crude Terminal',
    country: 'AO',
    lat: -5.5500,
    lng: 12.2000,
    radiusNm: 4,
    portType: 'crude-loading',
    knownGrades: ['cabinda'],
    notes:
      'Cabinda Gulf Oil Company (CABGOC) — Angolan crude export terminal. Cabinda blend ~35°API sweet, often arbitraged with West African grades.',
  },
  {
    slug: 'luanda-port',
    name: 'Port of Luanda',
    country: 'AO',
    lat: -8.7733,
    lng: 13.3756,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Luanda — Angola\'s capital port. Sonangol Luanda Refinery (~65 kbd) onshore. Mixed product import + crude staging.',
  },
  {
    slug: 'walvis-bay-port',
    name: 'Port of Walvis Bay',
    country: 'NA',
    lat: -22.9530,
    lng: 14.4979,
    radiusNm: 4,
    portType: 'transshipment',
    notes:
      'Namibia\'s deepwater port — Atlantic-Cape rounding bunker stop. Some refined product imports for southern Africa.',
  },

  // ── East Africa + Southern Africa ──────────────────────────
  {
    slug: 'mombasa-port',
    name: 'Port of Mombasa',
    country: 'KE',
    lat: -4.0435,
    lng: 39.6682,
    radiusNm: 5,
    portType: 'mixed',
    notes:
      'Mombasa — East Africa\'s primary refined-product gateway. Serves Kenya, Uganda, Rwanda, Burundi, eastern DRC, South Sudan via the Northern Corridor pipeline.',
  },
  {
    slug: 'dar-es-salaam-port',
    name: 'Port of Dar es Salaam',
    country: 'TZ',
    lat: -6.8161,
    lng: 39.2891,
    radiusNm: 5,
    portType: 'mixed',
    notes:
      'Tanzania\'s primary port — Central Corridor gateway for Tanzania, Zambia, eastern DRC, Burundi, Rwanda. Refined product imports + transit.',
  },
  {
    slug: 'maputo-port',
    name: 'Port of Maputo',
    country: 'MZ',
    lat: -25.9692,
    lng: 32.5732,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Mozambique\'s capital port — serves South Africa\'s Witwatersrand inland market plus regional refined-product distribution.',
  },
  {
    slug: 'durban-port',
    name: 'Port of Durban',
    country: 'ZA',
    lat: -29.8587,
    lng: 31.0218,
    radiusNm: 5,
    portType: 'mixed',
    notes:
      'Durban — South Africa\'s busiest port. Hosts SAPREF (~180 kbd Shell/BP JV) + Engen Refinery (~135 kbd). Major crude import + refined product hub.',
  },
  {
    slug: 'cape-town-port',
    name: 'Port of Cape Town',
    country: 'ZA',
    lat: -33.9253,
    lng: 18.4239,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Cape Town — Western Cape gateway, Atlantic-Cape rounding bunker stop. Refined product imports for the Cape region.',
  },

  // ── Caribbean basin ────────────────────────────────────────
  // The Caribbean bbox (PR #289 was the Africa add; the Caribbean
  // bbox has existed since the original AISStream config). Without
  // these seeded, port-call detection for Caribbean refineries
  // also stays empty — fixing that parallel gap here.
  {
    slug: 'punta-caucedo-port',
    name: 'Punta Caucedo Refinery Port',
    country: 'DO',
    lat: 18.4194,
    lng: -69.6128,
    radiusNm: 3,
    portType: 'refinery',
    notes:
      'Refidomsa terminal — Dominican Republic\'s primary refining + import port. Active diesel/gasoline tender buyer.',
  },
  {
    slug: 'kingston-port',
    name: 'Kingston Oil Port (Petrojam)',
    country: 'JM',
    lat: 17.9683,
    lng: -76.7917,
    radiusNm: 3,
    portType: 'refinery',
    notes:
      'Petrojam — Jamaica\'s only refinery (~35 kbd). State-owned; PCJ subsidiary. Active GOJEP tender buyer for crude + refined products.',
  },
  {
    slug: 'gdansk-port',
    name: 'Port of Gdańsk (Naftoport)',
    country: 'PL',
    lat: 54.4031,
    lng: 18.6776,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Gdańsk Naftoport — Poland\'s primary crude + refined products import ' +
      'terminal. Co-located with the Lotos / Orlen Gdańsk refinery (~120 kbd). ' +
      'Primary discharge point for Polish strategic reserve diesel imports ' +
      'sourced from ARA / NWE.',
  },
  {
    slug: 'port-au-prince-varreux',
    name: 'Port-au-Prince (Varreux Terminal)',
    country: 'HT',
    lat: 18.5800,
    lng: -72.3400,
    radiusNm: 3,
    portType: 'mixed',
    notes:
      'Varreux is Haiti\'s main fuel-import terminal — Total / Dinasa / Sun ' +
      'Auto operate. Vessel-to-vessel and barge discharge common. No domestic ' +
      'refining — all products imported, mostly USGC and Caribbean transit.',
  },
  {
    slug: 'port-of-spain',
    name: 'Port of Spain',
    country: 'TT',
    lat: 10.6549,
    lng: -61.5176,
    radiusNm: 4,
    portType: 'mixed',
    notes:
      'Trinidad\'s capital port — refined product imports + LNG-adjacent activity. Petrotrin Pointe-à-Pierre refinery (mothballed 2018) lies south.',
  },
  {
    slug: 'freeport-borco',
    name: 'Freeport (BORCO Terminal)',
    country: 'BS',
    lat: 26.5333,
    lng: -78.6833,
    radiusNm: 4,
    portType: 'transshipment',
    notes:
      'Bahamas Oil Refining Co. — major Atlantic transshipment terminal. ~25M bbl storage, owned by Buckeye. Frequent Atlantic-basin crude / product staging.',
  },
  {
    slug: 'limetree-bay-port',
    name: 'Limetree Bay Terminal',
    country: 'VI',
    lat: 17.6800,
    lng: -64.7500,
    radiusNm: 3,
    portType: 'mixed',
    notes:
      'St. Croix USVI — former HOVENSA refinery, now Port Hamilton storage + transshipment. Still active terminal in regional refined-product staging.',
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = neon(url);
  const db = drizzle(client, { schema, casing: 'snake_case' });

  console.log(`Seeding ${PORTS.length} ports...`);
  for (const p of PORTS) {
    await db
      .insert(schema.ports)
      .values({
        slug: p.slug,
        name: p.name,
        country: p.country,
        lat: String(p.lat),
        lng: String(p.lng),
        geofenceRadiusNm: String(p.radiusNm),
        portType: p.portType,
        knownGrades: p.knownGrades ?? null,
        linkedEntitySlug: p.linkedEntitySlug ?? null,
        notes: p.notes ?? null,
      })
      .onConflictDoUpdate({
        target: schema.ports.slug,
        set: {
          name: p.name,
          country: p.country,
          lat: String(p.lat),
          lng: String(p.lng),
          geofenceRadiusNm: String(p.radiusNm),
          portType: p.portType,
          knownGrades: p.knownGrades ?? null,
          linkedEntitySlug: p.linkedEntitySlug ?? null,
          notes: p.notes ?? null,
          updatedAt: new Date(),
        },
      });
  }
  console.log(`Done. ${PORTS.length} ports upserted.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
