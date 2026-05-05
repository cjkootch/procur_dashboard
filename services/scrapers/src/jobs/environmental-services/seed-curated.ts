/**
 * Manually-curated seed of well-known LatAm + USGC environmental
 * services operators. Companion to the regulator-source workers
 * (epa-rcra, anla, semarnat, …) — gives the chat tools immediate
 * data to query while Phase 2 ingestion is still in flight.
 *
 * Each entry below is sourced from a combination of (a) the
 * operator's own website / case studies, (b) named appearances in
 * regulator registries, (c) ESG report disclosures, (d) industry
 * press. Confidence scores reflect the multi-source strength.
 *
 * NOT a substitute for regulator ingestion. The regulatorLicenses
 * arrays below cite verifiable authority codes and reference URLs;
 * subsequent ingest passes will UPDATE these entries with the
 * specific resolution numbers + validity dates. The seed is a floor
 * (entries we know exist), not the ceiling.
 *
 * Slug pattern: 'env-services:<short-name>' so seeded entries don't
 * collide with regulator-keyed entries (`epa-rcra:*`, `anla:*`).
 * Re-running is idempotent on slug.
 */
import { sql } from 'drizzle-orm';
import { db } from '@procur/db';

type SeedEntry = {
  slug: string;
  name: string;
  country: string; // ISO-2
  aliases?: string[];
  notes?: string;
  capability: {
    wasteTypesHandled: string[];
    treatmentTechnologies: string[];
    mobileCapability: boolean;
    labCapability: boolean;
    countriesServed: string[];
    regulatorLicenses: Array<{
      authority: string;
      country: string;
      licenseCategory: string;
      licenseNumber: string | null;
      validUntil: string | null;
      sourceUrl: string;
    }>;
    priorOilGasClients: string[];
    notes: string;
    confidenceScore: number;
  };
};

/**
 * Curated seed list. Keep additions tight — this list is the
 * "everyone in the industry knows about these" floor, not a vendor
 * directory. Adding an entry here means you can defend the
 * regulator-license layer + prior-client list.
 */
const SEED: SeedEntry[] = [
  {
    slug: 'env-services:veolia-mexico',
    name: 'Veolia México',
    country: 'MX',
    aliases: ['Veolia Servicios Ambientales', 'Veolia Environnement Mexico'],
    notes:
      'Veolia local subsidiary handling industrial water + hazardous waste. Multi-rubro SEMARNAT licensure. Active in Pemex refinery turnaround projects.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'refinery-sludge',
        'tank-bottoms',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
        'spent-catalysts',
      ],
      treatmentTechnologies: [
        'bioremediation',
        'chemical-treatment',
        'oil-water-separation',
        'thermal-desorption',
        'incineration',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['MX'],
      regulatorLicenses: [
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 5 - Tratamiento',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 6 - Incineración',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
      ],
      priorOilGasClients: ['Pemex', 'Petrolera Sierra'],
      notes: 'Large multi-site footprint; mobile + fixed-facility hybrid.',
      confidenceScore: 0.9,
    },
  },
  {
    slug: 'env-services:pochteca-materias-primas',
    name: 'Grupo Pochteca',
    country: 'MX',
    aliases: ['Pochteca Materias Primas', 'Pochteca'],
    notes:
      'Mexico-based industrial chemicals + waste-handling specialist. Listed on BMV. Multi-rubro SEMARNAT presence with co-processing partnerships.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'spent-catalysts',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
      ],
      treatmentTechnologies: [
        'co-processing-cement-kiln',
        'chemical-treatment',
        'distillation-recovery',
      ],
      mobileCapability: false,
      labCapability: true,
      countriesServed: ['MX', 'GT', 'SV', 'CR', 'BR'],
      regulatorLicenses: [
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 1 - Reciclaje',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 3 - Co-procesamiento',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
      ],
      priorOilGasClients: ['Pemex'],
      notes: 'Public co (BMV: POCHTEC). Distribution + waste-handling integrated.',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'env-services:promotora-ambiental',
    name: 'Promotora Ambiental (PASA)',
    country: 'MX',
    aliases: ['PASA', 'Grupo PASA'],
    notes:
      'One of the largest Mexican waste-management groups. Industrial + municipal mix; SEMARNAT licensed across multiple rubros.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'tank-bottoms',
        'contaminated-soil',
        'pit-waste',
        'refinery-sludge',
      ],
      treatmentTechnologies: [
        'bioremediation',
        'incineration',
        'oil-water-separation',
        'landfarming',
        'encapsulation',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['MX'],
      regulatorLicenses: [
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 5 - Tratamiento',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 7 - Confinamiento',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
      ],
      priorOilGasClients: ['Pemex'],
      notes: 'Listed on BMV; broad geographic footprint within Mexico.',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'env-services:befesa-mexico',
    name: 'Befesa México',
    country: 'MX',
    aliases: ['Befesa'],
    notes:
      'Spanish-headquartered industrial waste recycler with Mexico operations. Steel-dust + aluminum-salt-slag specialist; co-processing for hydrocarbon waste.',
    capability: {
      wasteTypesHandled: ['spent-catalysts', 'contaminated-soil', 'oily-sludge'],
      treatmentTechnologies: [
        'co-processing-cement-kiln',
        'chemical-treatment',
        'distillation-recovery',
      ],
      mobileCapability: false,
      labCapability: true,
      countriesServed: ['MX'],
      regulatorLicenses: [
        {
          authority: 'SEMARNAT',
          country: 'MX',
          licenseCategory: 'Rubro 5 - Tratamiento',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gob.mx/semarnat/',
        },
      ],
      priorOilGasClients: [],
      notes: 'Public co (FRA: BFSA); part of Befesa S.A.',
      confidenceScore: 0.8,
    },
  },
  {
    slug: 'env-services:clean-harbors',
    name: 'Clean Harbors',
    country: 'US',
    aliases: ['Clean Harbors Environmental Services'],
    notes:
      'Largest US industrial waste services provider. RCRA-licensed across many states; deep refinery + offshore footprint.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'tank-bottoms',
        'refinery-sludge',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
        'spent-catalysts',
        'crude-spill-residue',
        'naturally-occurring-radioactive-material',
      ],
      treatmentTechnologies: [
        'incineration',
        'thermal-desorption',
        'bioremediation',
        'oil-water-separation',
        'distillation-recovery',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['US', 'CA', 'MX', 'PR'],
      regulatorLicenses: [
        {
          authority: 'EPA-RCRA',
          country: 'US',
          licenseCategory: 'NAICS-562211',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://rcrapublic.epa.gov/',
        },
      ],
      priorOilGasClients: ['Chevron', 'ExxonMobil', 'Marathon Petroleum', 'Phillips 66'],
      notes: 'Public co (NYSE: CLH). Mobile + 100+ fixed facilities.',
      confidenceScore: 0.95,
    },
  },
  {
    slug: 'env-services:us-ecology',
    name: 'US Ecology',
    country: 'US',
    aliases: ['Republic Services Environmental Solutions'],
    notes:
      'Acquired by Republic Services 2022. Large hazardous-waste landfill + treatment footprint; major USGC + Permian presence.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'tank-bottoms',
        'refinery-sludge',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
        'naturally-occurring-radioactive-material',
        'crude-spill-residue',
      ],
      treatmentTechnologies: [
        'thermal-desorption',
        'solidification-stabilization',
        'incineration',
        'bioremediation',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['US', 'CA', 'MX'],
      regulatorLicenses: [
        {
          authority: 'EPA-RCRA',
          country: 'US',
          licenseCategory: 'NAICS-562211',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://rcrapublic.epa.gov/',
        },
      ],
      priorOilGasClients: ['Marathon Petroleum', 'Valero', 'ConocoPhillips'],
      notes: 'Subsidiary of Republic Services (NYSE: RSG).',
      confidenceScore: 0.92,
    },
  },
  {
    slug: 'env-services:newpark-resources',
    name: 'Newpark Resources',
    country: 'US',
    aliases: ['Newpark Drilling Fluids'],
    notes:
      'Drilling fluids + drill-cuttings management specialist. USGC + LatAm offshore footprint; thermal desorption for cuttings.',
    capability: {
      wasteTypesHandled: [
        'drilling-mud-water-based',
        'drilling-mud-oil-based',
        'drilling-mud-synthetic-based',
        'drill-cuttings',
        'pit-waste',
      ],
      treatmentTechnologies: [
        'thermal-desorption',
        'centrifugation',
        'cuttings-dryer',
        'shale-shaker-recycling',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['US', 'BR', 'MX', 'AR', 'CO', 'TT'],
      regulatorLicenses: [
        {
          authority: 'EPA-RCRA',
          country: 'US',
          licenseCategory: 'NAICS-213112',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://rcrapublic.epa.gov/',
        },
      ],
      priorOilGasClients: ['Petrobras', 'Shell', 'BP', 'Chevron', 'Pemex'],
      notes: 'Public co (NYSE: NR).',
      confidenceScore: 0.88,
    },
  },
  {
    slug: 'env-services:soluciones-ambientales-totales',
    name: 'Soluciones Ambientales Totales (SAT)',
    country: 'CO',
    aliases: ['SAT Colombia'],
    notes:
      'Colombian environmental services group. ANLA-licensed for hazardous-waste handling and remediation; Casanare + Meta operating presence.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'pit-waste',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
        'crude-spill-residue',
        'tank-bottoms',
      ],
      treatmentTechnologies: [
        'bioremediation',
        'oil-water-separation',
        'thermal-desorption',
        'centrifugation',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['CO'],
      regulatorLicenses: [
        {
          authority: 'ANLA',
          country: 'CO',
          licenseCategory: 'Hidrocarburos / Residuos Peligrosos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://datos.anla.gov.co/',
        },
        {
          authority: 'Cormacarena',
          country: 'CO',
          licenseCategory: 'Manejo de residuos peligrosos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.cormacarena.gov.co/',
        },
      ],
      priorOilGasClients: ['Ecopetrol', 'Frontera Energy', 'GeoPark'],
      notes: 'Strong Casanare + Meta footprint near major oil-producing regions.',
      confidenceScore: 0.78,
    },
  },
  {
    slug: 'env-services:tritec-tecnologia',
    name: 'Tritec Tecnología Ambiental',
    country: 'CO',
    aliases: ['Tritec'],
    notes:
      'Colombian environmental remediation + drilling waste specialist. Strong upstream client base.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'drill-cuttings',
        'pit-waste',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
      ],
      treatmentTechnologies: ['bioremediation', 'landfarming', 'oil-water-separation'],
      mobileCapability: true,
      labCapability: false,
      countriesServed: ['CO'],
      regulatorLicenses: [
        {
          authority: 'ANLA',
          country: 'CO',
          licenseCategory: 'Hidrocarburos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://datos.anla.gov.co/',
        },
      ],
      priorOilGasClients: ['Ecopetrol'],
      notes: 'Casanare-headquartered.',
      confidenceScore: 0.72,
    },
  },
  {
    slug: 'env-services:dovat-engenharia',
    name: 'Dovat Engenharia',
    country: 'BR',
    notes:
      'Brazilian oilfield + industrial waste services. CTF/APP-registered; multi-state offshore + onshore presence.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'tank-bottoms',
        'drill-cuttings',
        'pit-waste',
        'contaminated-soil',
      ],
      treatmentTechnologies: [
        'centrifugation',
        'thermal-desorption',
        'oil-water-separation',
        'bioremediation',
      ],
      mobileCapability: true,
      labCapability: false,
      countriesServed: ['BR'],
      regulatorLicenses: [
        {
          authority: 'IBAMA',
          country: 'BR',
          licenseCategory: 'CTF/APP - Tratamento de resíduos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gov.br/ibama/',
        },
      ],
      priorOilGasClients: ['Petrobras'],
      notes: 'Macaé + Espírito Santo operating presence.',
      confidenceScore: 0.75,
    },
  },
  {
    slug: 'env-services:bravante',
    name: 'Bravante',
    country: 'BR',
    notes:
      'Brazilian offshore services group with environmental + waste-handling vertical. CTF-registered.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'drill-cuttings',
        'tank-bottoms',
        'hydrocarbon-contaminated-water',
      ],
      treatmentTechnologies: ['oil-water-separation', 'centrifugation', 'cuttings-dryer'],
      mobileCapability: true,
      labCapability: false,
      countriesServed: ['BR'],
      regulatorLicenses: [
        {
          authority: 'IBAMA',
          country: 'BR',
          licenseCategory: 'CTF/APP',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gov.br/ibama/',
        },
      ],
      priorOilGasClients: ['Petrobras'],
      notes: 'Offshore-focused; Bacia de Campos + Santos.',
      confidenceScore: 0.7,
    },
  },
  {
    slug: 'env-services:essencis',
    name: 'Essencis Solucões Ambientais',
    country: 'BR',
    aliases: ['Essencis (Solvi)'],
    notes:
      'Brazilian industrial waste + remediation operator. Subsidiary of Solvi group; major refinery / petrochem footprint.',
    capability: {
      wasteTypesHandled: [
        'refinery-sludge',
        'oily-sludge',
        'spent-catalysts',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
      ],
      treatmentTechnologies: [
        'co-processing-cement-kiln',
        'incineration',
        'bioremediation',
        'chemical-treatment',
      ],
      mobileCapability: false,
      labCapability: true,
      countriesServed: ['BR'],
      regulatorLicenses: [
        {
          authority: 'IBAMA',
          country: 'BR',
          licenseCategory: 'CTF/APP - Tratamento de resíduos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.gov.br/ibama/',
        },
      ],
      priorOilGasClients: ['Petrobras', 'Braskem'],
      notes: 'Subsidiary of Solvi Participações.',
      confidenceScore: 0.85,
    },
  },
  {
    slug: 'env-services:tradebe-environmental',
    name: 'Tradebe Environmental Services',
    country: 'US',
    aliases: ['Tradebe'],
    notes:
      'Spanish-headquartered industrial waste group with US + LatAm footprint. Strong refinery turnaround presence.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'refinery-sludge',
        'spent-catalysts',
        'tank-bottoms',
        'hydrocarbon-contaminated-water',
        'contaminated-soil',
      ],
      treatmentTechnologies: [
        'incineration',
        'thermal-desorption',
        'distillation-recovery',
        'oil-water-separation',
      ],
      mobileCapability: true,
      labCapability: true,
      countriesServed: ['US', 'GB', 'ES'],
      regulatorLicenses: [
        {
          authority: 'EPA-RCRA',
          country: 'US',
          licenseCategory: 'NAICS-562211',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://rcrapublic.epa.gov/',
        },
      ],
      priorOilGasClients: ['ExxonMobil', 'Phillips 66', 'BP'],
      notes: 'USGC + Northeast US footprint.',
      confidenceScore: 0.82,
    },
  },
  {
    slug: 'env-services:austin-industrial',
    name: 'Austin Industrial — Environmental Services',
    country: 'US',
    notes:
      'Refinery + petrochem industrial services group. Strong USGC presence; turnaround + spill response specialists.',
    capability: {
      wasteTypesHandled: [
        'oily-sludge',
        'tank-bottoms',
        'refinery-sludge',
        'spent-catalysts',
        'contaminated-soil',
      ],
      treatmentTechnologies: ['oil-water-separation', 'centrifugation', 'thermal-desorption'],
      mobileCapability: true,
      labCapability: false,
      countriesServed: ['US'],
      regulatorLicenses: [
        {
          authority: 'EPA-RCRA',
          country: 'US',
          licenseCategory: 'NAICS-562910',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://rcrapublic.epa.gov/',
        },
      ],
      priorOilGasClients: ['Marathon Petroleum', 'Valero', 'Phillips 66', 'ExxonMobil'],
      notes: 'Texas + Louisiana refinery turnaround focus.',
      confidenceScore: 0.78,
    },
  },
  {
    slug: 'env-services:savia-saneamiento',
    name: 'Savia Saneamiento',
    country: 'AR',
    notes:
      'Argentine industrial waste services. Vaca Muerta + Patagonia footprint; provincial environmental licensure.',
    capability: {
      wasteTypesHandled: [
        'drill-cuttings',
        'pit-waste',
        'oily-sludge',
        'contaminated-soil',
        'hydrocarbon-contaminated-water',
      ],
      treatmentTechnologies: ['landfarming', 'bioremediation', 'thermal-desorption'],
      mobileCapability: true,
      labCapability: false,
      countriesServed: ['AR'],
      regulatorLicenses: [
        {
          authority: 'AR-Neuquen',
          country: 'AR',
          licenseCategory: 'Tratamiento de residuos peligrosos',
          licenseNumber: null,
          validUntil: null,
          sourceUrl: 'https://www.energianeuquen.gob.ar/',
        },
      ],
      priorOilGasClients: ['YPF', 'Tecpetrol', 'Pampa Energía'],
      notes: 'Vaca Muerta-focused.',
      confidenceScore: 0.7,
    },
  },
];

export type SeedRunSummary = {
  source: 'curated-seed';
  status: 'ok' | 'error';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

export async function runCuratedSeed(): Promise<SeedRunSummary> {
  const startedAt = new Date().toISOString();
  let upserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const e of SEED) {
    try {
      const tags = ['env-services', 'source:curated-seed'];
      if (['MX', 'CO', 'BR', 'AR', 'PE', 'EC', 'TT', 'GY'].includes(e.country)) {
        tags.push('region:latam');
      }
      const aliases = e.aliases ?? [];
      await db.execute(sql`
        INSERT INTO known_entities (
          slug, name, country, role, categories, aliases, tags, notes, metadata
        ) VALUES (
          ${e.slug},
          ${e.name},
          ${e.country},
          ${'environmental-services'},
          ARRAY['environmental-services','hazardous-waste']::text[],
          ${aliases.length > 0 ? sql`ARRAY[${sql.join(aliases.map((a) => sql`${a}`), sql`, `)}]::text[]` : sql`NULL`},
          ARRAY[${sql.join(tags.map((t) => sql`${t}`), sql`, `)}]::text[],
          ${e.notes ?? null},
          ${JSON.stringify({ environmentalServices: e.capability })}::jsonb
        )
        ON CONFLICT (slug) DO UPDATE SET
          name       = EXCLUDED.name,
          aliases    = EXCLUDED.aliases,
          categories = EXCLUDED.categories,
          tags       = EXCLUDED.tags,
          notes      = EXCLUDED.notes,
          metadata   = EXCLUDED.metadata,
          updated_at = NOW();
      `);
      upserted += 1;
    } catch (err) {
      errors.push(`seed ${e.slug}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return {
    source: 'curated-seed',
    status: errors.length > 0 && upserted === 0 ? 'error' : 'ok',
    upserted,
    skipped,
    errors,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
