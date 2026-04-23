import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JamaicaGojepScraper } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixtures() {
  const [listing, d23401, d23412, d23418] = await Promise.all([
    readFile(join(FIX_DIR, 'listing.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-23401.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-23412.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-23418.html'), 'utf8'),
  ]);
  return {
    listing,
    details: {
      'https://www.gojep.gov.jm/epps/cft/viewCurrentNotice.do?noticeId=23401': d23401,
      'https://www.gojep.gov.jm/epps/cft/viewCurrentNotice.do?noticeId=23412': d23412,
      'https://www.gojep.gov.jm/epps/cft/viewCurrentNotice.do?noticeId=23418': d23418,
    },
  };
}

describe('JamaicaGojepScraper', () => {
  it('parses the listing into 3 raw opportunities', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();

    assert.equal(raws.length, 3);
    assert.equal(raws[0]?.sourceReferenceId, 'MOHW-2026-042');
    assert.equal(raws[1]?.sourceReferenceId, 'NWA-2026-017');
    assert.equal(raws[2]?.sourceReferenceId, 'MOEYI-2026-008');
  });

  it('normalizes a health tender with value, dates, and docs', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const [raw] = await scraper.fetch();
    assert.ok(raw);

    const norm = await scraper.parse(raw);
    assert.ok(norm, 'parse returned null');

    assert.equal(norm.title, 'Supply of PCR testing consumables to Kingston Public Hospital');
    assert.equal(norm.referenceNumber, 'MOHW-2026-042');
    assert.equal(norm.agencyName, 'Ministry of Health and Wellness');
    assert.equal(norm.currency, 'JMD');
    assert.equal(norm.valueEstimate, 125_000_000);
    assert.equal(norm.type, 'Open — ITB');
    assert.equal(norm.deadlineTimezone, 'America/Jamaica');
    assert.ok(norm.publishedAt instanceof Date);
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.documents?.length, 2);
    assert.match(norm.documents?.[0]?.originalUrl ?? '', /viewAttachmentAction\.do/);
  });

  it('normalizes a framework agreement even without explicit value', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new JamaicaGojepScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const framework = raws.find((r) => r.sourceReferenceId === 'MOEYI-2026-008');
    assert.ok(framework);

    const norm = await scraper.parse(framework);
    assert.ok(norm);
    assert.equal(norm.valueEstimate, undefined);
    assert.equal(norm.type, 'Framework agreement');
  });

  it('returns null on malformed raw data', async () => {
    const scraper = new JamaicaGojepScraper({ fixtureHtml: { listing: '', details: {} } });
    const norm = await scraper.parse({
      sourceReferenceId: '',
      sourceUrl: 'x',
      rawData: { referenceNumber: '', title: '' } as unknown as Record<string, unknown>,
    });
    assert.equal(norm, null);
  });
});
