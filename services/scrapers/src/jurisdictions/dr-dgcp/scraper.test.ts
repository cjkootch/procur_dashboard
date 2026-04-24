import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrDgcpScraper, parseDrDate } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixtures() {
  const [listing, salud, mopc] = await Promise.all([
    readFile(join(FIX_DIR, 'listing.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-salud.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-mopc.html'), 'utf8'),
  ]);
  return {
    listing,
    details: {
      'https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/Index?noticeUID=DGCP-001-A':
        salud,
      'https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/Index?noticeUID=DGCP-002-B':
        mopc,
    },
  };
}

describe('parseDrDate', () => {
  it('parses long Spanish format with "de"', () => {
    const d = parseDrDate('27 de noviembre de 2025');
    assert.ok(d);
    // Stored as UTC after America/Santo_Domingo (-04) conversion
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
    assert.equal(d.getUTCDate(), 5);
  });
  it('falls back to numeric format', () => {
    const d = parseDrDate('15/11/2025');
    assert.ok(d);
    assert.equal(d.getUTCMonth(), 10);
  });
  it('returns null for unparseable input', () => {
    assert.equal(parseDrDate(''), null);
    assert.equal(parseDrDate('not a date'), null);
  });
});

describe('DrDgcpScraper', () => {
  it('extracts all listing rows and detail URLs', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new DrDgcpScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 3);
    assert.equal(raws[0]!.sourceReferenceId, 'SAL-CCC-LPN-2025-0042');
  });

  it('parses a Salud DOP-denominated tender end-to-end', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new DrDgcpScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const salud = raws.find((r) => r.sourceReferenceId === 'SAL-CCC-LPN-2025-0042');
    assert.ok(salud);

    const norm = await scraper.parse(salud);
    assert.ok(norm);
    assert.equal(norm.title, 'Adquisición de equipos médicos para hospitales regionales');
    assert.equal(norm.agencyName, 'Ministerio de Salud Pública');
    assert.equal(norm.currency, 'DOP');
    assert.equal(norm.valueEstimate, 185_400_000);
    assert.equal(norm.language, 'es');
    assert.equal(norm.deadlineTimezone, 'America/Santo_Domingo');
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.documents?.length, 2);
    assert.equal(norm.category, 'Equipos médicos y de laboratorio');
  });

  it('detects USD currency from the value text on a MOPC tender', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new DrDgcpScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const mopc = raws.find((r) => r.sourceReferenceId === 'MOPC-CCC-CP-2025-0103');
    assert.ok(mopc);

    const norm = await scraper.parse(mopc);
    assert.ok(norm);
    assert.equal(norm.currency, 'USD');
    assert.equal(norm.valueEstimate, 12_500_000);
    assert.equal(norm.type, 'Comparación de Precios');
  });

  it('handles ISO-format dates on the EOI row without a detail page', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new DrDgcpScraper({
      fixtureHtml: {
        listing: fixtureHtml.listing,
        details: {
          // Missing on purpose — the fetch loop should still emit the row,
          // and parse() should fall back to the listing-only metadata.
          ...fixtureHtml.details,
          'https://comunidad.comprasdominicana.gob.do/Public/Tendering/OpportunityDetail/Index?noticeUID=DGCP-003-C':
            '<html><body></body></html>',
        },
      },
    });
    const raws = await scraper.fetch();
    const eoi = raws.find((r) => r.sourceReferenceId === 'EDUC-EOI-2025-009');
    assert.ok(eoi);

    const norm = await scraper.parse(eoi);
    assert.ok(norm);
    assert.equal(norm.title.startsWith('Expression of Interest'), true);
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.deadlineAt.getUTCFullYear(), 2025);
  });
});
