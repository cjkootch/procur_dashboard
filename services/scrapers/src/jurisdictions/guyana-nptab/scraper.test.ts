import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuyanaNptabScraper } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixtures() {
  const [listing, pharma, road] = await Promise.all([
    readFile(join(FIX_DIR, 'listing.html'), 'utf8'),
    readFile(join(FIX_DIR, 'post-moph.html'), 'utf8'),
    readFile(join(FIX_DIR, 'post-mopi.html'), 'utf8'),
  ]);
  return {
    listing,
    posts: {
      'https://nptab.gov.gy/ifb/moph-2026-gy-031-pharmaceutical-supplies/': pharma,
      'https://nptab.gov.gy/ifb/mopi-2026-gy-044-georgetown-road/': road,
    },
  };
}

describe('GuyanaNptabScraper', () => {
  it('discovers tender post URLs from the listing', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 2);
  });

  it('extracts reference, agency, value, and deadline from free-text body', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const pharma = raws.find((r) => r.sourceUrl.includes('moph'));
    assert.ok(pharma);

    const norm = await scraper.parse(pharma);
    assert.ok(norm);
    assert.equal(norm.referenceNumber, 'MOPH/2026/GY/031');
    assert.ok(norm.agencyName?.includes('Ministry of Public Health'));
    assert.equal(norm.currency, 'GYD');
    assert.equal(norm.valueEstimate, 185_400_000);
    assert.equal(norm.deadlineTimezone, 'America/Guyana');
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.documents?.length, 2);
  });

  it('handles posts with no explicit value but valid deadline', async () => {
    const fixtureHtml = await loadFixtures();
    const scraper = new GuyanaNptabScraper({ fixtureHtml });
    const raws = await scraper.fetch();
    const road = raws.find((r) => r.sourceUrl.includes('mopi'));
    assert.ok(road);

    const norm = await scraper.parse(road);
    assert.ok(norm);
    assert.equal(norm.referenceNumber, 'MOPI/2026/GY/044');
    assert.equal(norm.valueEstimate, undefined);
    assert.ok(norm.deadlineAt instanceof Date);
  });
});
