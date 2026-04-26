import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChileMpScraper, chileDetailUrl, type ChileMpListItem } from './scraper';

const baseItem: ChileMpListItem = {
  CodigoExterno: '1234-56-LR26',
  Nombre: 'Adquisición de equipos médicos para hospitales regionales',
  CodigoEstado: 5,
  Estado: 'Publicada',
  FechaCierre: '2026-05-15T15:00:00',
  FechaCreacion: '2026-04-25T12:30:00',
};

describe('chileDetailUrl', () => {
  it('embeds the CodigoExterno into the public detail URL', () => {
    const url = chileDetailUrl('5678-90-LP26');
    assert.match(url, /idlicitacion=5678-90-LP26/);
    assert.match(url, /^https:\/\/www\.mercadopublico\.cl\//);
  });
});

describe('ChileMpScraper', () => {
  it('returns 0 rows and warns when no ticket is configured (no fixtures)', async () => {
    const original = process.env.MERCADO_PUBLICO_TICKET;
    delete process.env.MERCADO_PUBLICO_TICKET;
    try {
      const scraper = new ChileMpScraper();
      const raws = await scraper.fetch();
      assert.equal(raws.length, 0);
    } finally {
      if (original !== undefined) process.env.MERCADO_PUBLICO_TICKET = original;
    }
  });

  it('walks every lookback day, dedup by CodigoExterno', async () => {
    const calls: string[] = [];
    const scraper = new ChileMpScraper({
      lookbackDays: 3,
      fixtureFetch: async (dateKey) => {
        calls.push(dateKey);
        // Return the same row on every day to verify dedup.
        return [baseItem];
      },
    });
    const raws = await scraper.fetch();
    assert.equal(calls.length, 3);
    assert.equal(raws.length, 1);
    assert.equal(raws[0]!.sourceReferenceId, '1234-56-LR26');
    assert.match(raws[0]!.sourceUrl, /idlicitacion=1234-56-LR26/);
  });

  it('continues past a single failed day fetch', async () => {
    let callCount = 0;
    const scraper = new ChileMpScraper({
      lookbackDays: 3,
      fixtureFetch: async () => {
        callCount += 1;
        if (callCount === 2) throw new Error('simulated 503');
        return [
          {
            ...baseItem,
            CodigoExterno: `CL-${callCount}`,
          },
        ];
      },
    });
    const raws = await scraper.fetch();
    assert.equal(callCount, 3);
    assert.equal(raws.length, 2);
  });

  it('normalizes a published bid into CLP / Spanish / TZ-tagged', async () => {
    const scraper = new ChileMpScraper({
      lookbackDays: 1,
      fixtureFetch: async () => [baseItem],
    });
    const [raw] = await scraper.fetch();
    assert.ok(raw);
    const norm = await scraper.parse(raw);
    assert.ok(norm);
    assert.equal(norm.title, baseItem.Nombre);
    assert.equal(norm.referenceNumber, baseItem.CodigoExterno);
    assert.equal(norm.currency, 'CLP');
    assert.equal(norm.language, 'es');
    assert.equal(norm.deadlineTimezone, 'America/Santiago');
    assert.ok(norm.publishedAt);
    assert.ok(norm.deadlineAt);
    assert.equal(norm.deadlineAt!.toISOString(), '2026-05-15T19:00:00.000Z');
  });

  it('drops items whose CodigoEstado is not 5 (Publicada)', async () => {
    const scraper = new ChileMpScraper({
      lookbackDays: 1,
      fixtureFetch: async () => [
        baseItem,
        { ...baseItem, CodigoExterno: 'AWARDED-1', CodigoEstado: 7 },
        { ...baseItem, CodigoExterno: 'CLOSED-1', CodigoEstado: 6 },
      ],
    });
    const raws = await scraper.fetch();
    const norms = await Promise.all(raws.map((r) => scraper.parse(r)));
    const kept = norms.filter((n) => n !== null);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.sourceReferenceId, '1234-56-LR26');
  });
});
