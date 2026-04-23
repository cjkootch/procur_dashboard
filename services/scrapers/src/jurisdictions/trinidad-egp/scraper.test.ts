import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrinidadEgpScraper, type PageFetcher } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

class MapFetcher implements PageFetcher {
  constructor(private readonly map: Record<string, string>) {}
  async fetchRendered(url: string): Promise<string> {
    const html = this.map[url];
    if (!html) throw new Error(`no fixture for ${url}`);
    return html;
  }
}

async function loadFetcher() {
  const [listing, moh, wasa] = await Promise.all([
    readFile(join(FIX_DIR, 'listing.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-moh.html'), 'utf8'),
    readFile(join(FIX_DIR, 'detail-wasa.html'), 'utf8'),
  ]);
  return new MapFetcher({
    'https://egp.gov.tt/public/notices': listing,
    'https://egp.gov.tt/public/notices/moh-tt-2026-073': moh,
    'https://egp.gov.tt/public/notices/wasa-tt-2026-091': wasa,
  });
}

describe('TrinidadEgpScraper', () => {
  it('parses 2 tenders from the listing', async () => {
    const fetcher = await loadFetcher();
    const scraper = new TrinidadEgpScraper({ fetcher });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 2);
    assert.equal(raws[0]?.sourceReferenceId, 'MOH-TT-2026-073');
  });

  it('normalizes a health tender with value and documents', async () => {
    const fetcher = await loadFetcher();
    const scraper = new TrinidadEgpScraper({ fetcher });
    const [raw] = await scraper.fetch();
    assert.ok(raw);

    const norm = await scraper.parse(raw);
    assert.ok(norm);
    assert.equal(norm.title, 'Procurement of mobile mammography units — North Central RHA');
    assert.equal(norm.referenceNumber, 'MOH-TT-2026-073');
    assert.equal(norm.currency, 'TTD');
    assert.equal(norm.valueEstimate, 8_400_000);
    assert.equal(norm.type, 'Open Tender');
    assert.equal(norm.deadlineTimezone, 'America/Port_of_Spain');
    assert.ok(norm.agencyName?.includes('Ministry of Health'));
    assert.ok(norm.deadlineAt instanceof Date);
    assert.equal(norm.documents?.length, 2);
  });

  it('normalizes WASA works tender', async () => {
    const fetcher = await loadFetcher();
    const scraper = new TrinidadEgpScraper({ fetcher });
    const raws = await scraper.fetch();
    const wasa = raws.find((r) => r.sourceReferenceId === 'WASA-TT-2026-091');
    assert.ok(wasa);

    const norm = await scraper.parse(wasa);
    assert.ok(norm);
    assert.equal(norm.agencyName, 'Water and Sewerage Authority');
    assert.equal(norm.valueEstimate, 12_750_000);
  });
});
