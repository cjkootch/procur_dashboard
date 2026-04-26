/**
 * Colombia — SECOP II via Socrata Open Data API.
 *
 * Portal:  https://www.colombiacompra.gov.co
 * API:     https://www.datos.gov.co/resource/p6dx-8zbt.json
 *          (SODA / Socrata — public, no auth, rate-limited but generous)
 *
 * Strategy: pull every record with `estado_de_apertura_del_proceso=Abierto`
 * and `fecha_de_recepcion_de > now` (deadline still in the future), order
 * by closing-soonest. Socrata caps any single response at 1000 rows; we
 * paginate via $offset until the page returns empty.
 *
 * The dataset is enormous (~7M historical rows) so the future-deadline
 * predicate is load-bearing — without it the response size explodes.
 *
 * Anonymous requests are rate-limited; if `DATOS_GOV_CO_APP_TOKEN` is
 * present, we forward it as `X-App-Token` to bump our quota. Both states
 * work.
 */
import {
  TenderScraper,
  fetchWithRetry,
  parseTenderDate,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';

const RESOURCE_URL = 'https://www.datos.gov.co/resource/p6dx-8zbt.json';
const PORTAL = 'https://www.colombiacompra.gov.co';
const TZ = 'America/Bogota';

/** Socrata caps `$limit` at 1000; that's also our pagination chunk. */
const PAGE_SIZE = 1000;

/** Hard cap on pages walked per run, just in case the result set grows
 *  unexpectedly. 50 pages × 1000 rows = 50k, far above the usual ~500
 *  active-with-future-deadline rows. */
const MAX_PAGES = 50;

export type ColombiaSecopRow = {
  id_del_proceso?: string;
  referencia_del_proceso?: string;
  nombre_del_procedimiento?: string;
  descripci_n_del_procedimiento?: string;
  entidad?: string;
  ciudad_entidad?: string;
  fase?: string;
  modalidad_de_contratacion?: string;
  tipo_de_contrato?: string;
  estado_de_apertura_del_proceso?: string;
  estado_del_procedimiento?: string;
  precio_base?: string;
  fecha_de_publicacion_del?: string;
  fecha_de_recepcion_de?: string;
  urlproceso?: { url?: string };
};

type ScraperInput = {
  appToken?: string;
  /** Skip the network and use this in tests. */
  fixtureFetch?: (offset: number, limit: number) => Promise<ColombiaSecopRow[]>;
  /** Override "now" for deterministic tests. */
  now?: Date;
};

function isoDateNoMillis(date: Date): string {
  // Socrata floating timestamps want yyyy-MM-ddTHH:mm:ss.SSS or just
  // yyyy-MM-ddTHH:mm:ss — without TZ suffix, since the column is a
  // floating timestamp rather than fixed_timestamp.
  return date.toISOString().slice(0, 23);
}

export class ColombiaSecopScraper extends TenderScraper {
  readonly jurisdictionSlug = 'colombia';
  readonly sourceName = 'colombia-secop';
  readonly portalUrl = PORTAL;

  private readonly appToken: string | undefined;
  private readonly fixtureFetch?: ScraperInput['fixtureFetch'];
  private readonly now: Date;

  constructor(input: ScraperInput = {}) {
    super();
    this.appToken = input.appToken ?? process.env.DATOS_GOV_CO_APP_TOKEN;
    this.fixtureFetch = input.fixtureFetch;
    this.now = input.now ?? new Date();
  }

  async fetch(): Promise<RawOpportunity[]> {
    const out: RawOpportunity[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const rows = this.fixtureFetch
        ? await this.fixtureFetch(offset, PAGE_SIZE)
        : await this.fetchPage(offset, PAGE_SIZE);

      if (rows.length === 0) break;

      for (const row of rows) {
        const id = row.id_del_proceso;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          sourceReferenceId: id,
          sourceUrl: row.urlproceso?.url ?? PORTAL,
          rawData: row as unknown as Record<string, unknown>,
        });
      }

      if (rows.length < PAGE_SIZE) break;
    }

    return out;
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const r = raw.rawData as unknown as ColombiaSecopRow;
    if (!r.id_del_proceso || !r.nombre_del_procedimiento) return null;

    const valueRaw = r.precio_base ? Number.parseFloat(r.precio_base) : NaN;
    const valueEstimate = Number.isFinite(valueRaw) && valueRaw > 0 ? valueRaw : undefined;

    return {
      sourceReferenceId: r.id_del_proceso,
      sourceUrl: raw.sourceUrl,
      title: r.nombre_del_procedimiento,
      description: r.descripci_n_del_procedimiento,
      referenceNumber: r.referencia_del_proceso ?? r.id_del_proceso,
      type: r.tipo_de_contrato ?? r.modalidad_de_contratacion,
      agencyName: r.entidad,
      currency: 'COP',
      valueEstimate,
      publishedAt: parseTenderDate(r.fecha_de_publicacion_del ?? null, TZ) ?? undefined,
      deadlineAt: parseTenderDate(r.fecha_de_recepcion_de ?? null, TZ) ?? undefined,
      deadlineTimezone: TZ,
      language: 'es',
      rawContent: r as unknown as Record<string, unknown>,
    };
  }

  private async fetchPage(offset: number, limit: number): Promise<ColombiaSecopRow[]> {
    const where = `fecha_de_recepcion_de > '${isoDateNoMillis(this.now)}'`;
    const params = new URLSearchParams({
      estado_de_apertura_del_proceso: 'Abierto',
      $where: where,
      $order: 'fecha_de_recepcion_de ASC',
      $limit: String(limit),
      $offset: String(offset),
    });

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.appToken) headers['X-App-Token'] = this.appToken;

    const res = await fetchWithRetry(`${RESOURCE_URL}?${params.toString()}`, { headers });
    if (!res.ok) throw new Error(`SECOP responded ${res.status}`);
    return (await res.json()) as ColombiaSecopRow[];
  }
}
