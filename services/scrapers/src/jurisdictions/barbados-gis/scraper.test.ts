import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BarbadosGisScraper } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixtures() {
  const [listing, moh, bwa] = await Promise.all([
    readFile(join(FIX_DIR, 'listing-notices.html'), 'utf8'),
    readFile(join(FIX_DIR, 'post-moh.html'), 'utf8'),
    readFile(join(FIX_DIR, 'post-bwa.html'), 'utf8'),
  ]);
  return {
    // Both LISTING_PATHS feed from the same fixture so the de-duplicated
    // post URL set still matches the count we assert on.
    listings: {
      '/category/notices/': listing,
      '/category/tenders/': listing,
    },
    posts: {
      'https://gisbarbados.gov.bb/2025/11/moh-tender-nutrition-supplies-2025/': moh,
      'https://gisbarbados.gov.bb/2025/11/bwa-pumping-station-rehabilitation/': bwa,
    },
  };
}

describe('BarbadosGisScraper', () => {
  it('discovers tender post URLs from the listing pages and dedupes', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new BarbadosGisScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 2);
  });

  it('extracts reference, agency, BBD value, and deadline from a MOH post', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new BarbadosGisScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const moh = raws.find((r) => r.sourceUrl.includes('moh-tender'));
    assert.ok(moh);

    const norm = await scraper.parse(moh);
    assert.ok(norm);
    assert.equal(norm.referenceNumber, 'MOH-BB-2025-0042');
    assert.ok(norm.agencyName?.includes('Ministry of Health'));
    assert.equal(norm.currency, 'BBD');
    assert.equal(norm.valueEstimate, 1_250_000);
    assert.equal(norm.deadlineTimezone, 'America/Barbados');
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.documents?.length, 1);
  });

  it('switches to USD when the value text indicates USD', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new BarbadosGisScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const bwa = raws.find((r) => r.sourceUrl.includes('bwa-pumping'));
    assert.ok(bwa);

    const norm = await scraper.parse(bwa);
    assert.ok(norm);
    assert.equal(norm.currency, 'USD');
    assert.equal(norm.valueEstimate, 4_500_000);
    assert.ok(norm.agencyName?.includes('Barbados Water Authority'));
  });
});
