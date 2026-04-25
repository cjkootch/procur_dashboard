import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JamaicaGojepScraper, type JamaicaRawData } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixture(): Promise<{ listing: string }> {
  const listing = await readFile(join(FIX_DIR, 'listing.html'), 'utf8');
  return { listing };
}

describe('JamaicaGojepScraper', () => {
  it('parses the opened-tenders listing into rows', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    // GOJEP renders 10 per page; tolerate +/- a few for layout drift.
    assert.ok(raws.length >= 5, `expected >=5 rows, got ${raws.length}`);
    assert.ok(raws.length <= 25, `expected <=25 rows, got ${raws.length}`);
  });

  it('emits stable GOJEP-<resourceId> reference ids', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    for (const r of raws) {
      assert.match(r.sourceReferenceId, /^GOJEP-\d+$/);
      assert.match(r.sourceUrl, /\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=\d+$/);
    }
    const ids = new Set(raws.map((r) => r.sourceReferenceId));
    assert.equal(ids.size, raws.length, 'reference ids must be unique');
  });

  it('captures title, reference, agency, deadline, method, status per row', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const sample = raws[0]?.rawData as unknown as JamaicaRawData;
    assert.ok(sample.title.length > 5);
    assert.ok(sample.referenceNumber.length > 0);
    assert.ok(sample.agency.length > 2);
    // Closing date format is "Day Mon DD HH:mm:ss COT YYYY".
    assert.match(sample.closingDateText, /\d{4}\s*$/);
    assert.ok(sample.method.length > 0);
    assert.ok(sample.evaluationStatus.length > 0);
  });

  it('normalizes a row into an opportunity with JMD currency and valid deadline', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const first = raws[0];
    assert.ok(first);

    const norm = await scraper.parse(first);
    assert.ok(norm, 'parse returned null');

    assert.equal(norm.currency, 'JMD');
    assert.equal(norm.language, 'en');
    assert.equal(norm.deadlineTimezone, 'America/Jamaica');
    assert.ok(norm.title.length > 0);
    assert.ok(norm.deadlineAt instanceof Date);
  });

  it('returns null on malformed raw data', async () => {
    const scraper = new JamaicaGojepScraper({ fixtureHtml: { listing: '' } });
    const norm = await scraper.parse({
      sourceReferenceId: '',
      sourceUrl: 'x',
      rawData: { title: '' } as unknown as Record<string, unknown>,
    });
    assert.equal(norm, null);
  });
});
