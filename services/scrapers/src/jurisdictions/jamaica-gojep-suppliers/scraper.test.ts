import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JamaicaGojepSuppliersScraper } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadFixture() {
  const gs = await readFile(join(FIX_DIR, 'list-gs.html'), 'utf8');
  // Use the same fixture for w14/w5 in tests — content shape is identical.
  return { gs, w14: gs, w5: gs };
}

describe('JamaicaGojepSuppliersScraper', () => {
  it('parses ~10 supplier rows from a single page', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepSuppliersScraper({ fixtureHtml });
    const rows = await scraper.fetch();
    // 10 per category × 3 categories = ~30 with the same fixture used everywhere.
    assert.ok(rows.length >= 20, `expected >=20 rows, got ${rows.length}`);
    assert.ok(rows.length <= 60, `expected <=60 rows, got ${rows.length}`);
  });

  it('emits stable, unique reference ids per (category, organisation)', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepSuppliersScraper({ fixtureHtml });
    const rows = await scraper.fetch();
    for (const row of rows) {
      assert.match(row.sourceReferenceId, /^(gs|w14|w5)-[a-z0-9-]+$/);
    }
    const ids = new Set(rows.map((r) => r.sourceReferenceId));
    assert.equal(ids.size, rows.length, 'reference ids must be unique within a fetch');
  });

  it('captures organisation, address, phone, country, and registration date', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepSuppliersScraper({ fixtureHtml });
    const rows = await scraper.fetch();
    const sample = rows[0];
    assert.ok(sample);
    assert.ok(sample.organisationName.length > 0);
    assert.equal(sample.country, 'Jamaica');
    // Registration date is usually present; allow some rows without one.
    const withDates = rows.filter((r) => r.registeredAtText);
    assert.ok(withDates.length / rows.length > 0.5);
  });

  it('parses every category when fixture is provided', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepSuppliersScraper({ fixtureHtml });
    const rows = await scraper.fetch();
    const categories = new Set(rows.map((r) => r.sourceCategory));
    assert.deepEqual([...categories].sort(), ['gs', 'w14', 'w5']);
  });

  it('skips rows that look like layout / header / paging', async () => {
    const fixtureHtml = await loadFixture();
    const scraper = new JamaicaGojepSuppliersScraper({ fixtureHtml });
    const rows = await scraper.fetch();
    // No row should have the literal "#" or "Organisation Name" as its
    // organisation name (those are header cells).
    for (const r of rows) {
      assert.notEqual(r.organisationName, '#');
      assert.notEqual(r.organisationName.toLowerCase(), 'organisation name');
    }
  });
});
