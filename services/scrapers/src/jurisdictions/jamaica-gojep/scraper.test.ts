import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JamaicaGojepScraper, type JamaicaRawData } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixtures(): Promise<{ listing: string; awards: string }> {
  const [listing, awards] = await Promise.all([
    readFile(join(FIX_DIR, 'listing.html'), 'utf8'),
    readFile(join(FIX_DIR, 'award-notices.html'), 'utf8'),
  ]);
  return { listing, awards };
}

describe('JamaicaGojepScraper', () => {
  it('parses opened-tenders + award-notices surfaces in one fetch', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    // Each fixture page returns ~10 rows; total should be ~20.
    assert.ok(raws.length >= 10, `expected >=10 rows, got ${raws.length}`);
    assert.ok(raws.length <= 30, `expected <=30 rows, got ${raws.length}`);

    const surfaces = new Set(
      raws.map((r) => (r.rawData as unknown as JamaicaRawData).surface),
    );
    assert.ok(surfaces.has('opened-tenders'), 'expected opened-tenders rows');
    assert.ok(surfaces.has('award-notices'), 'expected award-notices rows');
  });

  it('emits stable GOJEP-<resourceId> reference ids that dedupe across surfaces', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    for (const r of raws) {
      assert.match(r.sourceReferenceId, /^GOJEP-\d+$/);
      assert.match(r.sourceUrl, /\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=\d+$/);
    }
    // resourceIds may overlap intentionally (same tender on both surfaces);
    // the upsert layer dedupes. We just confirm each row has a valid id.
    assert.ok(raws.every((r) => r.sourceReferenceId.length > 6));
  });

  it('captures method + evaluation status on opened-tender rows', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const opened = raws
      .map((r) => r.rawData as unknown as JamaicaRawData)
      .filter((d) => d.surface === 'opened-tenders');
    assert.ok(opened.length > 0);
    const sample = opened[0]!;
    assert.ok(sample.title.length > 5);
    assert.ok(sample.referenceNumber.length > 0);
    assert.ok(sample.agency.length > 2);
    assert.match(sample.closingDateText ?? '', /\d{4}\s*$/);
    assert.ok((sample.method ?? '').length > 0);
    assert.ok((sample.evaluationStatus ?? '').length > 0);
  });

  it('captures awarded value + PDF on award-notice rows', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const awards = raws
      .map((r) => r.rawData as unknown as JamaicaRawData)
      .filter((d) => d.surface === 'award-notices');
    assert.ok(awards.length > 0, 'expected at least one award-notice row');
    const withValue = awards.filter((a) => parseFloat(a.awardedValue ?? '0') > 0);
    const withPdf = awards.filter((a) => a.awardNoticePdfUrl);
    assert.ok(withValue.length / awards.length > 0.5, 'expected >50% of awards to have values');
    assert.ok(withPdf.length / awards.length > 0.5, 'expected >50% of awards to have PDF links');
  });

  it('normalizes an opened-tender row with JMD currency + valid deadline', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const opened = raws.find(
      (r) => (r.rawData as unknown as JamaicaRawData).surface === 'opened-tenders',
    );
    assert.ok(opened);
    const norm = await scraper.parse(opened);
    assert.ok(norm);
    assert.equal(norm.currency, 'JMD');
    assert.equal(norm.language, 'en');
    assert.equal(norm.deadlineTimezone, 'America/Jamaica');
    assert.ok(norm.deadlineAt instanceof Date);
  });

  it('normalizes an award-notice row with awarded value + attached PDF', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const award = raws.find(
      (r) => (r.rawData as unknown as JamaicaRawData).surface === 'award-notices',
    );
    assert.ok(award);
    const norm = await scraper.parse(award);
    assert.ok(norm);
    assert.equal(norm.currency, 'JMD');
    assert.ok((norm.valueEstimate ?? 0) > 0);
    assert.ok(norm.documents);
    assert.equal(norm.documents.length, 1);
    assert.equal(norm.documents[0]?.documentType, 'tender_document');
    assert.match(norm.documents[0]?.originalUrl ?? '', /downloadNoticeForES\.do/);
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
