import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuyanaNptabScraper, type GuyanaRawData } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixture(): Promise<{ listing: string }> {
  const listing = await readFile(join(FIX_DIR, 'listing.html'), 'utf8');
  return { listing };
}

describe('GuyanaNptabScraper', () => {
  it('parses every row of the Ninja Tables listing', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    // Live snapshot held 233 listings; allow drift +/- 50% for fixture refreshes.
    assert.ok(raws.length > 100, `expected >100 rows, got ${raws.length}`);
    assert.ok(raws.length < 500, `expected <500 rows, got ${raws.length}`);
  });

  it('emits stable NPTA-<rowId> reference ids that are unique per row', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    for (const r of raws) {
      assert.match(r.sourceReferenceId, /^NPTA-\d+$/);
    }
    const ids = new Set(raws.map((r) => r.sourceReferenceId));
    assert.equal(ids.size, raws.length);
  });

  it('captures title, agency, deadline, method, status per row', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const sample = raws[0]?.rawData as unknown as GuyanaRawData;
    assert.ok(sample.title.length > 10);
    assert.ok(sample.agency.length > 5);
    assert.match(sample.method, /^(NCB|ICB|Open|RFQ|Request)/i);
    assert.ok(sample.status.length > 0);
  });

  it('attaches a PDF advert URL on >80% of rows', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const withPdf = raws.filter((r) => (r.rawData as unknown as GuyanaRawData).pdfUrl);
    assert.ok(
      withPdf.length / raws.length > 0.8,
      `expected >80% of rows to have a PDF link, got ${withPdf.length}/${raws.length}`,
    );
  });

  it('normalizes a row into an opportunity with GYD currency + en language', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const first = raws[0];
    assert.ok(first);
    const norm = await scraper.parse(first);
    assert.ok(norm);
    assert.equal(norm.currency, 'GYD');
    assert.equal(norm.language, 'en');
    assert.ok(norm.title.length > 0);
  });
});
