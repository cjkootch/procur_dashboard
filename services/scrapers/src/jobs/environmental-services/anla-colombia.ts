/**
 * ANLA Colombia federal environmental licensing ingest.
 * STATUS: partially-wired, needs sibling-layer discovery.
 *
 * History: brief-v1 said `datos.anla.gov.co` (CKAN) — that hostname
 * doesn't resolve. Brief-v2 (post-correction) gives the real
 * structure: ANLA publishes its open data via an ArcGIS Hub portal
 * at `datosabiertos-anla.hub.arcgis.com`, with feature-server REST
 * APIs at `portalsig.anla.gov.co` for programmatic access.
 *
 * The brief calls out the Hidrocarburos layer specifically:
 *   https://portalsig.anla.gov.co/publico/rest/services/OPENDATA/
 *     ANLA_Areas_Licenciadas_Hidrocarburos/MapServer/0
 *
 * That layer's licensee = the oil company holding the project
 * license (Ecopetrol, Frontera, etc.), NOT an environmental
 * services operator. For env-services rolodex purposes, we want
 * the Residuos Peligrosos and Remediación Ambiental sibling layers
 * — those licensees ARE env-services operators. Sibling layer URLs
 * need discovery against the live ArcGIS Hub portal.
 *
 * Until the sibling layers are identified, the worker returns
 * `skipped-needs-discovery` with the brief's documented base URL
 * so the next iteration has a clear target.
 *
 * Implementation pattern once layers are identified:
 *
 *   GET <layer-base>/query?where=1=1&outFields=*&f=json
 *     &resultOffset=<n>&resultRecordCount=500
 *   → returns { features: [{ attributes: { titular, sector, ... } }] }
 *   → Group by `titular` (operator), upsert one row per operator,
 *     merge sectors/licenses across multiple feature rows.
 */

export type AnlaRunSummary = {
  source: 'anla';
  status: 'ok' | 'error' | 'skipped-needs-discovery';
  upserted: number;
  skipped: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

export async function runAnla(): Promise<AnlaRunSummary> {
  const ts = new Date().toISOString();
  return {
    source: 'anla',
    status: 'skipped-needs-discovery',
    upserted: 0,
    skipped: 0,
    errors: [
      'ANLA needs sibling-layer discovery on the ArcGIS feature ' +
        'server. Per docs/environmental-services-rolodex-brief.md §4.3, ' +
        'the canonical surface is ' +
        'https://datosabiertos-anla.hub.arcgis.com (Hub portal) with ' +
        'feature-server APIs at https://portalsig.anla.gov.co/publico/rest/services/OPENDATA/. ' +
        'The brief cites the Hidrocarburos layer ' +
        '(ANLA_Areas_Licenciadas_Hidrocarburos/MapServer/0) but that ' +
        "licensee is the oil company, not the env-services operator. " +
        'For our rolodex purpose, the Residuos Peligrosos and ' +
        'Remediación Ambiental sibling layers are needed. Discover ' +
        'those by browsing datosabiertos-anla.hub.arcgis.com, find the ' +
        'matching MapServer layer URLs, then update this worker to ' +
        'POST <layer>/query?where=1=1&outFields=*&f=json&resultOffset=N. ' +
        'Group by attributes.titular, upsert with slug=`anla:<operator-slug>`.',
    ],
    startedAt: ts,
    finishedAt: ts,
  };
}
