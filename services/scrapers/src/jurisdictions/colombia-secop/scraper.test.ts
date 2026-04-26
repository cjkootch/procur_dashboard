import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ColombiaSecopScraper, type ColombiaSecopRow } from './scraper';

const baseRow: ColombiaSecopRow = {
  id_del_proceso: 'CO1.REQ.10322919',
  referencia_del_proceso: 'EPLH-CD-2026-001',
  nombre_del_procedimiento: 'PRESTAR EL SERVICIO A TODO COSTO FUMIGACIÓN',
  descripci_n_del_procedimiento:
    'Servicio de fumigación, control de plagas y desinfección para las instalaciones del establecimiento.',
  entidad: 'ESTABLECIMIENTO PENITENCIARIO LAS HELICONIAS',
  fase: 'Presentación de oferta',
  modalidad_de_contratacion: 'Mínima cuantía',
  tipo_de_contrato: 'Prestación de servicios',
  estado_de_apertura_del_proceso: 'Abierto',
  estado_del_procedimiento: 'Seleccionado',
  precio_base: '27000000',
  fecha_de_publicacion_del: '2026-04-06T00:00:00.000',
  fecha_de_recepcion_de: '2026-05-15T17:00:00.000',
  urlproceso: {
    url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID=CO1.NTC.10179634',
  },
};

describe('ColombiaSecopScraper', () => {
  it('paginates through every Socrata page and stops on a short page', async () => {
    const calls: Array<{ offset: number; limit: number }> = [];
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset, limit) => {
        calls.push({ offset, limit });
        if (offset === 0) return Array.from({ length: limit }, (_, i) => ({
          ...baseRow,
          id_del_proceso: `CO1.PAGE0.${i}`,
        }));
        if (offset === limit) return Array.from({ length: 250 }, (_, i) => ({
          ...baseRow,
          id_del_proceso: `CO1.PAGE1.${i}`,
        }));
        return [];
      },
    });
    const raws = await scraper.fetch();
    // 1000 + 250 = 1250 unique rows; pagination stops after the short page.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.offset, 0);
    assert.equal(calls[1]!.offset, 1000);
    assert.equal(raws.length, 1250);
  });

  it('dedupes rows that appear on multiple pages by id_del_proceso', async () => {
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset, limit) => {
        if (offset === 0) {
          // Fill page 1 to exactly PAGE_SIZE so pagination doesn't bail.
          const page = Array.from({ length: limit - 1 }, (_, i) => ({
            ...baseRow,
            id_del_proceso: `CO1.PADDING.${i}`,
          }));
          return [baseRow, ...page];
        }
        if (offset === limit) {
          // Page 2 repeats baseRow.id (dedup target) and adds CO1.C.
          return [baseRow, { ...baseRow, id_del_proceso: 'CO1.C' }];
        }
        return [];
      },
    });
    const raws = await scraper.fetch();
    const ids = raws.map((r) => r.sourceReferenceId);
    // baseRow's id appears once (deduped), CO1.C makes it through.
    assert.equal(ids.filter((i) => i === 'CO1.REQ.10322919').length, 1);
    assert.ok(ids.includes('CO1.C'));
  });

  it('normalizes a SECOP row into COP / Spanish / TZ-tagged shape', async () => {
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset) => (offset === 0 ? [baseRow] : []),
    });
    const [raw] = await scraper.fetch();
    assert.ok(raw);
    const norm = await scraper.parse(raw);
    assert.ok(norm);
    assert.equal(norm.title, baseRow.nombre_del_procedimiento);
    assert.equal(norm.referenceNumber, baseRow.referencia_del_proceso);
    assert.equal(norm.agencyName, baseRow.entidad);
    assert.equal(norm.currency, 'COP');
    assert.equal(norm.valueEstimate, 27_000_000);
    assert.equal(norm.language, 'es');
    assert.equal(norm.deadlineTimezone, 'America/Bogota');
    assert.match(norm.sourceUrl, /OpportunityDetail/);
    assert.ok(norm.publishedAt instanceof Date);
    assert.ok(norm.deadlineAt instanceof Date);
  });

  it('skips rows missing required fields', async () => {
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset) =>
        offset === 0 ? [{ ...baseRow, nombre_del_procedimiento: undefined }] : [],
    });
    const [raw] = await scraper.fetch();
    assert.ok(raw);
    const norm = await scraper.parse(raw);
    assert.equal(norm, null);
  });

  it('drops rows whose id_del_proceso is missing', async () => {
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset) =>
        offset === 0
          ? [{ ...baseRow, id_del_proceso: undefined }, baseRow]
          : [],
    });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 1);
    assert.equal(raws[0]!.sourceReferenceId, 'CO1.REQ.10322919');
  });

  it('treats precio_base of 0 as missing value', async () => {
    const scraper = new ColombiaSecopScraper({
      fixtureFetch: async (offset) =>
        offset === 0 ? [{ ...baseRow, precio_base: '0' }] : [],
    });
    const [raw] = await scraper.fetch();
    const norm = await scraper.parse(raw!);
    assert.ok(norm);
    assert.equal(norm.valueEstimate, undefined);
  });
});
