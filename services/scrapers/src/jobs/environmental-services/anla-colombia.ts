/**
 * ANLA Colombia — STATUS: needs further research.
 *
 * History of attempts:
 *   v1: tried CKAN at datos.anla.gov.co — DNS doesn't resolve.
 *   v2: tried ArcGIS feature-server discovery at
 *       portalsig.anla.gov.co/publico/rest/services/OPENDATA/.
 *       Discovery succeeded — folder enumerated 17 layers — but
 *       NONE matched env-services keywords (residuo / remediac /
 *       peligroso). The OPENDATA folder only publishes project-
 *       license geospatial data:
 *         - Áreas/Líneas Licenciadas Hidrocarburos (project areas)
 *         - Áreas Licenciadas Infraestructura
 *         - Áreas Licenciadas Mineria
 *         - Áreas Licenciadas Eléctrico
 *         - Áreas Licenciadas Agroquímicos
 *         - Áreas en Evaluación / Seguimiento (status variants)
 *
 *       In each layer the licensee is the project operator (e.g.
 *       Ecopetrol for a hydrocarbon block, ISA for a transmission
 *       line), NOT the env-services contractor we want for the
 *       env-services rolodex.
 *
 *       Conclusion: ANLA's ArcGIS portal exposes WHERE projects
 *       are located + WHO holds the project license, not WHO
 *       provides waste-handling / remediation services.
 *
 * Where the env-services data probably lives:
 *   - "Reporte de Licencias Ambientales" referenced in brief §4.3
 *     v1 — likely a downloadable CSV / PDF at ANLA's main site
 *     (anla.gov.co), separate from the geospatial portal.
 *   - Per-resolution PDFs at minambiente.gov.co or anla.gov.co
 *     /servicio-al-ciudadano (would require OCR + parse).
 *   - Or via the broader IDEAM / SISAIRE Colombian environmental
 *     data systems.
 *
 * Until that surface is identified, this worker returns
 * `skipped-needs-discovery`. Other workers (curated-seed,
 * SEMARNAT) carry coverage in the meantime; the curated seed
 * already includes 2 Colombian operators (SAT, Tritec).
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

/**
 * Layers the discovery pass actually found in ANLA's OPENDATA
 * folder — kept here for reference so the next iteration knows
 * what's available without re-running discovery.
 */
const ANLA_OPENDATA_LAYERS_DISCOVERED = [
  'OPENDATA/ANLA_Areas_Evaluacion_Infraestructura/0=Áreas en Evaluación Infraestructura',
  'OPENDATA/ANLA_Areas_Evaluacion_Mineria/0=Áreas en Evaluación Minería',
  'OPENDATA/ANLA_Areas_Licenciadas_Agroquimicos/0=Áreas Licenciadas Agroquimicos',
  'OPENDATA/ANLA_Areas_Licenciadas_Electrico/0=Áreas Licenciadas Eléctrico',
  'OPENDATA/ANLA_Areas_Licenciadas_Hidrocarburos/0=Áreas Licenciadas Hidrocarburos',
  'OPENDATA/ANLA_Areas_Licenciadas_Infraestructura/0=Áreas Licenciadas Infraestructura',
  'OPENDATA/ANLA_Areas_Licenciadas_Mineria/0=Áreas Licenciadas Minería',
  'OPENDATA/ANLA_EVALUACION_AREAS/0=Proyectos en Evaluación Areas',
  'OPENDATA/ANLA_EVALUACION_LINEAS/0=Proyectos en Evaluación Líneas',
  'OPENDATA/ANLA_Lineas_Evaluacion_Infraestructura/0=Líneas en Evaluación Infraestructura',
  'OPENDATA/ANLA_SEGUIMIENTO_AGROQUIMICOS/0,1=Proyectos + Áreas Agroquímicos en Seguimiento',
  'OPENDATA/ANLA_SEGUIMIENTO_ELECTRICO/1,2=Líneas + Áreas Eléctrico en Seguimiento',
  'OPENDATA/ANLA_SEGUIMIENTO_INFRAESTRUCTURA/0,1,2=Proyectos + Líneas + Áreas Infraestructura en Seguimiento',
  'OPENDATA/ANLA_SEGUIMIENTO_MINERIA/1=Áreas Mineria en Seguimiento',
];

export async function runAnla(): Promise<AnlaRunSummary> {
  const ts = new Date().toISOString();
  return {
    source: 'anla',
    status: 'skipped-needs-discovery',
    upserted: 0,
    skipped: 0,
    errors: [
      'ANLA OPENDATA ArcGIS folder only publishes project-license ' +
        'geospatial layers (project locations + project-license ' +
        'holders) — NOT env-services operators. Layers we found:\n  ' +
        ANLA_OPENDATA_LAYERS_DISCOVERED.join('\n  ') +
        '\nNext-step options for the env-services slice: ' +
        '(a) find the "Reporte de Licencias Ambientales" CSV/PDF ' +
        'on anla.gov.co (separate from the geospatial portal); ' +
        '(b) check IDEAM / SISAIRE Colombian environmental data ' +
        'systems; (c) per-resolution PDFs at minambiente.gov.co ' +
        '/servicio-al-ciudadano (would need OCR). Until then, ' +
        'curated-seed covers Colombia (SAT, Tritec).',
    ],
    startedAt: ts,
    finishedAt: ts,
  };
}
