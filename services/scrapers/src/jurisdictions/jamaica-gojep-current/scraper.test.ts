import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JamaicaGojepCurrentScraper,
  isLoginPage,
  parseGojepCurrentDate,
} from './scraper';

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
    assert.equal(
      isLoginPage(
        '<tr><td><a href="/epps/cft/prepareViewCfTWS.do?resourceId=1">x</a></td></tr>',
      ),
      false,
    );
  });
});

describe('parseGojepCurrentDate', () => {
  it('parses dd/MM/yyyy HH:mm:ss in Jamaica time', () => {
    const d = parseGojepCurrentDate('18/05/2026 11:00:00');
    assert.ok(d);
    // Jamaica = UTC-5 year-round, so 11:00 local → 16:00 UTC
    assert.equal(d.toISOString(), '2026-05-18T16:00:00.000Z');
  });
  it('parses date-only form', () => {
    const d = parseGojepCurrentDate('24/04/2026');
    assert.ok(d);
    assert.equal(d.toISOString(), '2026-04-24T05:00:00.000Z');
  });
  it('returns undefined for non-matching input', () => {
    assert.equal(parseGojepCurrentDate('Fri Apr 24 13:00:00 COT 2026'), undefined);
    assert.equal(parseGojepCurrentDate(''), undefined);
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

  it('parses every Current Competitions row from the listing fixture', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 3);
    const ids = raws.map((r) => r.sourceReferenceId).sort();
    assert.deepEqual(ids, ['9354555', '9358888', '9360111']);
  });

  it('reconstructs the absolute detail URL from the row link', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const first = raws.find((r) => r.sourceReferenceId === '9354555');
    assert.ok(first);
    assert.match(
      first.sourceUrl,
      /^https:\/\/www\.gojep\.gov\.jm\/epps\/cft\/prepareViewCfTWS\.do\?resourceId=9354555$/,
    );
  });

  it('normalizes the laptop tender end-to-end', async () => {
    const listing = await loadListing();
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const laptops = raws.find((r) => r.sourceReferenceId === '9354555');
    assert.ok(laptops);
    const norm = await scraper.parse(laptops);
    assert.ok(norm);
    assert.equal(
      norm.title,
      'The Supply and Delivery of 225 Laptops for all Parish Courts',
    );
    assert.ok(norm.description?.startsWith('The Court Administration Division'));
    assert.equal(norm.agencyName, 'Court Management Services');
    assert.equal(norm.referenceNumber, '9354555');
    assert.equal(norm.currency, 'JMD');
    assert.equal(norm.language, 'en');
    assert.equal(norm.deadlineTimezone, 'America/Jamaica');
    assert.equal(norm.type, 'Open - NCB');
    assert.equal(norm.category, 'Goods');
    assert.equal(norm.publishedAt!.toISOString(), '2026-04-24T21:10:21.000Z');
    assert.equal(norm.deadlineAt!.toISOString(), '2026-05-18T16:00:00.000Z');
  });

  it('drops rows whose link doesn\'t expose a prepareViewCfTWS resourceId', async () => {
    const malformed = `<table>
      <tr><td>1</td><td><a href="/epps/cft/somethingelse.do">No resourceId here</a></td><td>X</td><td></td><td>18/05/2026 11:00:00</td></tr>
    </table>`;
    const scraper = new JamaicaGojepCurrentScraper({ fixtureHtml: { listing: malformed } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 0);
  });
});
