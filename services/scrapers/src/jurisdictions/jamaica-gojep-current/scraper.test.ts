import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JamaicaGojepCurrentScraper, isLoginPage } from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadListing() {
  return readFile(join(FIX_DIR, 'listing.html'), 'utf8');
}

describe('isLoginPage', () => {
  it('detects an /epps/authenticate/login redirect body', () => {
    assert.equal(isLoginPage('<html>...redirect to /epps/authenticate/login...</html>'), true);
  });
  it('detects the bare login form by j_username field', () => {
    assert.equal(isLoginPage('<form><input name="j_username" /></form>'), true);
  });
  it('returns false on the actual tender list', () => {
    assert.equal(isLoginPage('<table class="displaytag"><tr><td>2026-X</td></tr></table>'), false);
  });
});

describe('JamaicaGojepCurrentScraper', () => {
  it('returns 0 rows and warns when GOJEP_SESSION_COOKIE is unset', async () => {
    const original = process.env.GOJEP_SESSION_COOKIE;
    delete process.env.GOJEP_SESSION_COOKIE;
    try {
      const scraper = new JamaicaGojepCurrentScraper();
      const raws = await scraper.fetch();
      assert.equal(raws.length, 0);
    } finally {
      if (original !== undefined) process.env.GOJEP_SESSION_COOKIE = original;
    }
  });

  it('parses every displayTag row from the listing fixture', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 3);
    const ids = raws.map((r) => r.sourceReferenceId).sort();
    assert.deepEqual(ids, ['12345', '24680', '67890']);
  });

  it('reconstructs the absolute detail URL from the row link', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const first = raws.find((r) => r.sourceReferenceId === '12345');
    assert.ok(first);
    assert.match(first.sourceUrl, /^https:\/\/www\.gojep\.gov\.jm\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=12345$/);
  });

  it('normalizes a row into JMD / America-Jamaica TZ shape', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const nwa = raws.find((r) => r.sourceReferenceId === '12345');
    assert.ok(nwa);
    const norm = await scraper.parse(nwa);
    assert.ok(norm);
    assert.equal(norm.title, 'Supply of asphalt for road resurfacing — Kingston');
    assert.equal(norm.agencyName, 'National Works Agency');
    assert.equal(norm.referenceNumber, '2026-NWA-001');
    assert.equal(norm.currency, 'JMD');
    assert.equal(norm.language, 'en');
    assert.equal(norm.deadlineTimezone, 'America/Jamaica');
    assert.equal(norm.type, 'Open Tender');
    assert.ok(norm.publishedAt instanceof Date);
    assert.ok(norm.deadlineAt instanceof Date);
  });

  it('drops rows whose link doesn\'t expose a prepareViewCfTWS resourceId', async () => {
    const malformed = `
      <table class="displaytag"><tbody>
        <tr><td>X-1</td><td><a href="/epps/cft/listCFT.do">No resourceId here</a></td><td>X</td><td>Mon Apr 14 09:00:00 EST 2026</td><td>Fri May 15 13:00:00 EST 2026</td></tr>
      </tbody></table>`;
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing: malformed } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 0);
  });
});
