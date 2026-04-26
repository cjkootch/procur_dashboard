/**
 * Chile — Mercado Público (ChileCompra).
 *
 * Portal:   https://www.mercadopublico.cl
 * API:      https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json
 * Auth:     Free ticket from https://desarrolladores.mercadopublico.cl
 *           — passed via env var MERCADO_PUBLICO_TICKET. The scraper
 *           degrades gracefully (returns 0 rows + warning) when the
 *           ticket is missing so a misconfigured env doesn't fail
 *           the cron run.
 *
 * Strategy: walk the last N days (default 14) of published bids, dedup
 * by `CodigoExterno`. List rows already include enough fields to render
 * a card (title, deadline, status, source code); detail enrichment for
 * value/agency/description can be a follow-up — the listing alone gives
 * Chile thousands of active opportunities.
 *
 * Pagination: the v1 API has no offset paging. The "fecha=ddmmyyyy"
 * filter returns every bid published that day (CodigoEstado=5). 14
 * day-walks ≈ Chile's typical active-bid horizon at any moment.
 */
import {
  TenderScraper,
  fetchWithRetry,
  parseTenderDate,
  type NormalizedOpportunity,
  type RawOpportunity,
} from '@procur/scrapers-core';
import { log } from '@procur/utils/logger';

const API_BASE = 'https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json';
const PORTAL = 'https://www.mercadopublico.cl';
const TZ = 'America/Santiago';

/**
 * Mercado Público "CodigoEstado" enumeration (subset we care about):
 *   5  Publicada    → still receiving offers
 *   6  Cerrada      → past deadline, evaluating
 *   7  Adjudicada   → awarded
 *   8  Desierta     → cancelled, no winner
 *  18  Revocada     → revoked
 *  19  Suspendida   → suspended
 * We surface only state 5 to our buyers. Everything else gets filtered
 * in parse().
 */
const STATE_ACTIVE = 5;

export type ChileMpListItem = {
  CodigoExterno: string;
  Nombre: string;
  CodigoEstado: number;
  Estado?: string;
  FechaCierre?: string;
  FechaCreacion?: string;
};

export type ChileMpRawData = ChileMpListItem & {
  detailUrl: string;
};

type ScraperInput = {
  /** Override env-based ticket (used by tests + local CLI). */
  ticket?: string;
  /** Days to walk back. Default 14. */
  lookbackDays?: number;
  /** Inject canned per-day responses for tests. Map keyed by ddmmyyyy. */
  fixtureFetch?: (dateKey: string) => Promise<ChileMpListItem[] | null>;
};

/**
 * Mercado Público returns naive local timestamps like "2026-05-15T15:00:00"
 * with no offset — which date-fns parseISO interprets as UTC, four hours
 * ahead of America/Santiago. Reformat to dd/MM/yyyy HH:mm so parseTenderDate
 * skips the ISO short-circuit and applies the timezone.
 */
function chileDate(input: string | undefined | null): string | null {
  if (!input) return null;
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (!m) return input;
  const [, year, month, day, hour, minute] = m;
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

function ddmmyyyy(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const y = date.getUTCFullYear();
  return `${d}${m}${y}`;
}

/**
 * Construct the public detail URL for a Mercado Público bid given its
 * external code. The CodigoExterno is also the "idLicitacion" the
 * portal accepts directly.
 */
export function chileDetailUrl(codigoExterno: string): string {
  return `${PORTAL}/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(codigoExterno)}`;
}

export class ChileMpScraper extends TenderScraper {
  readonly jurisdictionSlug = 'chile';
  readonly sourceName = 'chile-mp';
  readonly portalUrl = PORTAL;

  private readonly ticket: string | undefined;
  private readonly lookbackDays: number;
  private readonly fixtureFetch?: ScraperInput['fixtureFetch'];

  constructor(input: ScraperInput = {}) {
    super();
    this.ticket = input.ticket ?? process.env.MERCADO_PUBLICO_TICKET;
    this.lookbackDays = Math.max(1, input.lookbackDays ?? 14);
    this.fixtureFetch = input.fixtureFetch;
  }

  async fetch(): Promise<RawOpportunity[]> {
    if (!this.ticket && !this.fixtureFetch) {
      log.warn('chile.skipped_no_ticket', {
        message:
          'MERCADO_PUBLICO_TICKET not set — register at https://desarrolladores.mercadopublico.cl and add the ticket as a Trigger.dev env var.',
      });
      return [];
    }

    const seen = new Map<string, ChileMpRawData>();
    const today = new Date();

    for (let offset = 0; offset < this.lookbackDays; offset += 1) {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - offset);
      const key = ddmmyyyy(date);

      let items: ChileMpListItem[] | null;
      try {
        items = this.fixtureFetch
          ? await this.fixtureFetch(key)
          : await this.fetchDay(key);
      } catch (err) {
        log.warn('chile.day_fetch_failed', {
          dateKey: key,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!items) continue;

      for (const item of items) {
        if (!item.CodigoExterno || !item.Nombre) continue;
        if (seen.has(item.CodigoExterno)) continue;
        seen.set(item.CodigoExterno, {
          ...item,
          detailUrl: chileDetailUrl(item.CodigoExterno),
        });
      }
    }

    return Array.from(seen.values()).map((row) => ({
      sourceReferenceId: row.CodigoExterno,
      sourceUrl: row.detailUrl,
      rawData: row as unknown as Record<string, unknown>,
    }));
  }

  async parse(raw: RawOpportunity): Promise<NormalizedOpportunity | null> {
    const d = raw.rawData as unknown as ChileMpRawData;
    if (!d.Nombre || !d.CodigoExterno) return null;

    // The listing endpoint occasionally returns non-active states even
    // when filtered (caching/race) — drop them in parse() so they don't
    // show on the buyer-facing list.
    if (typeof d.CodigoEstado === 'number' && d.CodigoEstado !== STATE_ACTIVE) {
      return null;
    }

    return {
      sourceReferenceId: d.CodigoExterno,
      sourceUrl: raw.sourceUrl,
      title: d.Nombre,
      referenceNumber: d.CodigoExterno,
      currency: 'CLP',
      publishedAt: parseTenderDate(chileDate(d.FechaCreacion), TZ) ?? undefined,
      deadlineAt: parseTenderDate(chileDate(d.FechaCierre), TZ) ?? undefined,
      deadlineTimezone: TZ,
      language: 'es',
      rawContent: d as unknown as Record<string, unknown>,
    };
  }

  private async fetchDay(dateKey: string): Promise<ChileMpListItem[] | null> {
    const url = `${API_BASE}?fecha=${dateKey}&CodigoEstado=${STATE_ACTIVE}&ticket=${encodeURIComponent(
      this.ticket ?? '',
    )}`;
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`Mercado Público responded ${res.status}`);
    }
    const json = (await res.json()) as { Cantidad?: number; Listado?: ChileMpListItem[] };
    return json.Listado ?? [];
  }
}
