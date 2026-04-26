import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrDgcpScraper, parseDrDate, parseDrAmount } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadListing() {
  return readFile(join(FIX_DIR, 'listing.html'), 'utf8');
}

describe('parseDrDate', () => {
  it('parses long Spanish format with "de"', () => {
    const d = parseDrDate('27 de noviembre de 2025');
    assert.ok(d);
    assert.equal(d.getUTCMonth(), 10);
    assert.equal(d.getUTCDate(), 27);
  });
  it('parses Spanish month name without "de"', () => {
    const d = parseDrDate('5 octubre 2025');
    assert.ok(d);
    assert.equal(d.getUTCMonth(), 9);
    assert.equal(d.getUTCDate(), 5);
  });
  it('parses dd/MM/yyyy a las HH:mm form', () => {
    const d = parseDrDate('05/12/2025 a las 10:00');
    assert.ok(d);
    assert.equal(d.getUTCMonth(), 11);
  });
  it('strips Vortal "(UTC -4 hours)" trailer', () => {
    const d = parseDrDate('24/04/2026 18:00 (UTC -4 hours)');
    assert.ok(d);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 3);
    assert.equal(d.getUTCDate(), 24);
  });
  it('returns null for unparseable input', () => {
    assert.equal(parseDrDate(''), null);
    assert.equal(parseDrDate('not a date'), null);
  });
});

describe('parseDrAmount', () => {
  it('parses comma-thousands format', () => {
    assert.equal(parseDrAmount('1,500,000 Dominican Pesos'), 1_500_000);
    assert.equal(parseDrAmount('5,000.00 Dollars'), 5000);
  });
  it('parses period-thousands with comma decimal', () => {
    assert.equal(parseDrAmount('1.500.000,75'), 1_500_000.75);
  });
  it('returns undefined when no number present', () => {
    assert.equal(parseDrAmount('TBD'), undefined);
  });
});

describe('DrDgcpScraper', () => {
  it('extracts every VortalGrid row from the listing fixture', async () => {
    const listing = await loadListing();
    const scraper = new DrDgcpScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 3);
    const refs = raws.map((r) => r.sourceReferenceId).sort();
    assert.deepEqual(refs, [
      'CESAC-CCC-PEPU-2026-0003',
      'EDENORTE-CCC-PEIN-2026-0009',
      'EDESUR-DAF-CM-2026-0003',
    ]);
  });

  it('reconstructs the OpportunityDetail permalink from the row onclick', async () => {
    const listing = await loadListing();
    const scraper = new DrDgcpScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const edesur = raws.find((r) => r.sourceReferenceId === 'EDESUR-DAF-CM-2026-0003');
    assert.ok(edesur);
    assert.match(
      edesur.sourceUrl,
      /\/Public\/Tendering\/OpportunityDetail\/Index\?noticeUID=DO1\.NTC\.\d+/,
    );
  });

  it('normalizes a DOP-denominated tender end-to-end', async () => {
    const listing = await loadListing();
    const scraper = new DrDgcpScraper({ fixtureHtml: { listing } });
    const [first] = await scraper.fetch();
    assert.ok(first);
    const norm = await scraper.parse(first);
    assert.ok(norm);
    assert.equal(norm.referenceNumber, 'EDESUR-DAF-CM-2026-0003');
    assert.equal(norm.currency, 'DOP');
    assert.equal(norm.valueEstimate, 1_500_000);
    assert.equal(norm.agencyName, 'Empresa Distribuidora de Electricidad del Sur');
    assert.equal(norm.language, 'es');
    assert.ok(norm.title?.startsWith('Contratación de servicios de mantenimiento'));
    assert.ok(norm.publishedAt);
    assert.ok(norm.deadlineAt);
  });

  it('skips rows whose country column is not DO', async () => {
    const listing = await loadListing();
    const foreign = listing.replace(/>DO</g, '>US<');
    const scraper = new DrDgcpScraper({ fixtureHtml: { listing: foreign } });
    const raws = await scraper.fetch();
    const norms = await Promise.all(raws.map((r) => scraper.parse(r)));
    assert.ok(norms.every((n) => n === null));
  });
});
