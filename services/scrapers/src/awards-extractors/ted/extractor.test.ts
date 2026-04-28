import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TedAwardsExtractor, pickEnglish, collectWinners } from './extractor';

describe('pickEnglish', () => {
  it('prefers ENG, then EN, then any non-empty language', () => {
    assert.equal(pickEnglish({ ENG: 'Hello', FRA: 'Bonjour' }), 'Hello');
    assert.equal(pickEnglish({ EN: 'Hi' }), 'Hi');
    assert.equal(pickEnglish({ FRA: 'Bonjour' }), 'Bonjour');
  });

  it('handles array-valued multilingual fields', () => {
    assert.equal(pickEnglish({ ENG: ['Lot 1 description'] }), 'Lot 1 description');
  });

  it('returns null for missing/empty', () => {
    assert.equal(pickEnglish(undefined), null);
    assert.equal(pickEnglish({}), null);
  });
});

describe('collectWinners', () => {
  it('handles plain string array', () => {
    assert.deepEqual(collectWinners(['Acme Oil', 'Petrocorp']), ['Acme Oil', 'Petrocorp']);
  });

  it('handles multilingual record + dedupes identical names across languages', () => {
    assert.deepEqual(
      collectWinners({ ENG: 'Acme Oil', FRA: 'Acme Oil' }),
      ['Acme Oil'],
    );
  });

  it('returns empty array for missing/empty input', () => {
    assert.deepEqual(collectWinners(undefined), []);
    assert.deepEqual(collectWinners([]), []);
  });
});

describe('TedAwardsExtractor.streamAwards (fixture path)', () => {
  it('emits diesel + crude awards from synthetic fixture, drops non-fuel/food', async () => {
    const fixture = {
      notices: [
        {
          'publication-number': '12345-2024',
          'notice-title': { ENG: 'Diesel fuel framework agreement' },
          'notice-type': '29',
          'publication-date': '2024-09-15',
          'classification-cpv': ['09134200'],
          'buyer-name': { ENG: 'Italian Ministry of Defence' },
          'organisation-country-buyer': ['ITA'],
          'total-value': 5_000_000,
          'total-value-cur': ['EUR'],
          'winner-name': { ENG: 'Eni S.p.A.' },
          'winner-country': ['ITA'],
        },
        {
          'publication-number': '67890-2024',
          'notice-title': { ENG: 'Construction services for highway' },
          'notice-type': '29',
          'publication-date': '2024-09-20',
          'classification-cpv': ['45233100'], // construction
          'buyer-name': { ENG: 'Spanish Ministry of Transport' },
          'organisation-country-buyer': ['ESP'],
          'winner-name': { ENG: 'Builder Inc' },
        },
        {
          'publication-number': '11111-2024',
          'notice-title': { ENG: 'Strategic petroleum reserve crude purchase' },
          'notice-type': '29',
          'publication-date': '2024-09-10',
          'classification-cpv': ['09230000'],
          'buyer-name': { ENG: 'Greek Strategic Stocks Authority' },
          'organisation-country-buyer': ['GRC'],
          'total-value': 12_000_000,
          'total-value-cur': ['EUR'],
          'winner-name': ['Hellenic Petroleum'],
          'winner-country': ['GRC'],
        },
      ],
    };

    const extractor = new TedAwardsExtractor({ fixture });
    const out = [];
    for await (const a of extractor.streamAwards()) out.push(a);

    const ids = out.map((a) => a.award.sourceAwardId);
    assert.ok(ids.includes('12345-2024'), 'diesel award present');
    assert.ok(ids.includes('11111-2024'), 'crude award present');
    assert.ok(!ids.includes('67890-2024'), 'construction award skipped');
  });

  it('classifies CPV 09134200 as diesel and converts EUR value to USD', async () => {
    const fixture = {
      notices: [
        {
          'publication-number': 'D-1',
          'notice-title': { ENG: 'Diesel test' },
          'notice-type': '29',
          'publication-date': '2024-06-15',
          'classification-cpv': ['09134200'],
          'buyer-name': { ENG: 'Buyer' },
          'organisation-country-buyer': ['ITA'],
          'total-value': 1000,
          'total-value-cur': ['EUR'],
          'winner-name': ['Winner'],
        },
      ],
    };
    const extractor = new TedAwardsExtractor({ fixture });
    let found;
    for await (const a of extractor.streamAwards()) found = a;
    assert.ok(found);
    assert.deepEqual(found.award.categoryTags, ['diesel']);
    assert.equal(found.award.contractCurrency, 'EUR');
    assert.equal(found.award.buyerCountry, 'IT');
    // EUR-2024-06 rate ~1.078 → 1000 EUR ≈ 1078 USD
    assert.ok(
      found.award.contractValueUsd != null &&
        found.award.contractValueUsd > 1070 &&
        found.award.contractValueUsd < 1085,
      `expected ~1078 USD, got ${found.award.contractValueUsd}`,
    );
  });

  it('emits multiple awardees for consortium awards', async () => {
    const fixture = {
      notices: [
        {
          'publication-number': 'C-1',
          'notice-title': { ENG: 'Consortium award' },
          'notice-type': '29',
          'publication-date': '2024-09-15',
          'classification-cpv': ['09131000'],
          'buyer-name': { ENG: 'Buyer' },
          'organisation-country-buyer': ['DEU'],
          'winner-name': ['Lead Refiner GmbH', 'Consortium Partner SA'],
          'winner-country': ['DEU', 'FRA'],
        },
      ],
    };
    const extractor = new TedAwardsExtractor({ fixture });
    let found;
    for await (const a of extractor.streamAwards()) found = a;
    assert.ok(found);
    assert.equal(found.awardees.length, 2);
    assert.equal(found.awardees[0]?.supplier.country, 'DE');
    assert.equal(found.awardees[1]?.supplier.country, 'FR');
  });
});
