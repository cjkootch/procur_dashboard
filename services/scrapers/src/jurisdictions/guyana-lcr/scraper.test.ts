import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuyanaLcrScraper, type GuyanaLcrRawData } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixture(): Promise<{ listing: string }> {
  const listing = await readFile(join(FIX_DIR, 'listing.html'), 'utf8');
  return { listing };
}

describe('GuyanaLcrScraper', () => {
  it('parses every opportunity article from the listing', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaLcrScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    // Live snapshot held ~202 articles; allow drift +/- ~50%.
    assert.ok(raws.length > 100, `expected >100 rows, got ${raws.length}`);
    assert.ok(raws.length < 400, `expected <400 rows, got ${raws.length}`);
  });

  it('emits stable LCR-<slug> reference ids that are unique per opportunity', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaLcrScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    for (const r of raws) {
      assert.match(r.sourceReferenceId, /^LCR-[a-z0-9-]+$/);
      assert.match(r.sourceUrl, /lcregister\.petroleum\.gov\.gy\/supplier-notice\//);
    }
    const ids = new Set(raws.map((r) => r.sourceReferenceId));
    assert.equal(ids.size, raws.length, 'reference ids must be unique');
  });

  it('captures title, operator, dates, supply category, notice type', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaLcrScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const sample = raws[0]?.rawData as unknown as GuyanaLcrRawData;
    assert.ok(sample.title.length > 5);
    assert.ok(sample.operator.length > 2);
    // Most rows have at least one of the dates and one of the taxonomies.
    const withClosing = raws
      .map((r) => r.rawData as unknown as GuyanaLcrRawData)
      .filter((d) => d.closingDateText);
    const withCategory = raws
      .map((r) => r.rawData as unknown as GuyanaLcrRawData)
      .filter((d) => d.supplyCategory);
    const withNoticeType = raws
      .map((r) => r.rawData as unknown as GuyanaLcrRawData)
      .filter((d) => d.noticeType);
    // Closing date + notice type appear on every operator-published row
    // (verified ~100% on the live snapshot). Supply category is optional
    // — operators populate it about half the time, hence the looser bar.
    assert.ok(withClosing.length / raws.length > 0.7, 'expect >70% with closing date');
    assert.ok(withNoticeType.length / raws.length > 0.7, 'expect >70% with notice type');
    assert.ok(withCategory.length / raws.length > 0.4, 'expect >40% with supply category');
  });

  it('normalizes a row into an opportunity with USD currency + en language', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new GuyanaLcrScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const first = raws[0];
    assert.ok(first);
    const norm = await scraper.parse(first);
    assert.ok(norm);
    assert.equal(norm.currency, 'USD');
    assert.equal(norm.language, 'en');
    assert.equal(norm.deadlineTimezone, 'America/Guyana');
    assert.ok(norm.title.length > 0);
    assert.ok(norm.agencyName, 'operator should populate agencyName');
  });

  it('returns null on malformed raw data', async () => {
    const scraper = new GuyanaLcrScraper({ fixtureHtml: { listing: '' } });
    const norm = await scraper.parse({
      sourceReferenceId: '',
      sourceUrl: 'x',
      rawData: { title: '' } as unknown as Record<string, unknown>,
    });
    assert.equal(norm, null);
  });
});
