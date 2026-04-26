import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChileMpSessionScraper,
  isLoginPage,
  parseChileAmount,
} from './scraper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'fixtures');

async function loadListing() {
  return readFile(join(FIX_DIR, 'listing.html'), 'utf8');
}

describe('isLoginPage (chile-mp-session)', () => {
  it('detects a Keycloak realm redirect', () => {
    assert.equal(isLoginPage('<form action="/auth/realms/mp/login">'), true);
  });
  it('detects the Keycloak login form id', () => {
    assert.equal(isLoginPage('<form id="kc-login">'), true);
  });
  it('returns false on a real listing', () => {
    assert.equal(
      isLoginPage(
        '<table id="grdResultBidList"><tr><td><a href="DetailsAcquisition.aspx?idlicitacion=1234-56-LR26">x</a></td></tr></table>',
      ),
      false,
    );
  });
});

describe('parseChileAmount', () => {
  it('parses $ 185.400.000', () => {
    assert.equal(parseChileAmount('$ 185.400.000'), 185_400_000);
  });
  it('parses 1.234.567,89', () => {
    assert.equal(parseChileAmount('1.234.567,89'), 1_234_567.89);
  });
  it('returns undefined for non-numeric strings', () => {
    assert.equal(parseChileAmount('A convenir'), undefined);
  });
});

describe('ChileMpSessionScraper', () => {
  it('returns 0 rows and warns when no cookie is configured', async () => {
    const original = process.env.MERCADO_PUBLICO_SESSION_COOKIE;
    delete process.env.MERCADO_PUBLICO_SESSION_COOKIE;
    try {
      const scraper = new ChileMpSessionScraper();
      const raws = await scraper.fetch();
      assert.equal(raws.length, 0);
    } finally {
      if (original !== undefined) process.env.MERCADO_PUBLICO_SESSION_COOKIE = original;
    }
  });

  it('parses every grid row from the listing fixture', async () => {
    const listing = await loadListing();
    const scraper = new ChileMpSessionScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 3);
    const ids = raws.map((r) => r.sourceReferenceId).sort();
    assert.deepEqual(ids, ['1234-56-LR26', '5678-90-LP26', '9012-34-CO26']);
  });

  it('reconstructs the absolute DetailsAcquisition URL from the row link', async () => {
    const listing = await loadListing();
    const scraper = new ChileMpSessionScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const first = raws.find((r) => r.sourceReferenceId === '1234-56-LR26');
    assert.ok(first);
    assert.match(
      first.sourceUrl,
      /^https:\/\/www\.mercadopublico\.cl\/Procurement\/Modules\/RFB\/StepsProcessRFB\/DetailsAcquisition\.aspx\?idlicitacion=1234-56-LR26$/,
    );
  });

  it('normalizes a row into CLP / Spanish / TZ-tagged shape', async () => {
    const listing = await loadListing();
    const scraper = new ChileMpSessionScraper({ fixtureHtml: { listing } });
    const raws = await scraper.fetch();
    const salud = raws.find((r) => r.sourceReferenceId === '1234-56-LR26');
    assert.ok(salud);
    const norm = await scraper.parse(salud);
    assert.ok(norm);
    assert.equal(norm.title, 'Adquisición de equipos médicos para hospitales regionales');
    assert.equal(norm.agencyName, 'Servicio de Salud Metropolitano');
    assert.equal(norm.currency, 'CLP');
    assert.equal(norm.valueEstimate, 185_400_000);
    assert.equal(norm.language, 'es');
    assert.equal(norm.deadlineTimezone, 'America/Santiago');
    assert.ok(norm.deadlineAt instanceof Date);
  });

  it('returns 0 rows and warns when the response is the Keycloak login page', async () => {
    const loginHtml = '<html><form id="kc-login"></form></html>';
    const scraper = new ChileMpSessionScraper({
      sessionCookie: 'ASP.NET_SessionId=expired',
      fixtureHtml: { listing: loginHtml },
    });
    const raws = await scraper.fetch();
    assert.equal(raws.length, 0);
  });
});
