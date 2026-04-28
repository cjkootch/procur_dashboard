import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UngmAwardsExtractor, parseDetailPage } from './extractor';

describe('parseDetailPage', () => {
  it('extracts awardee from <dt>/<dd> labeled detail layout', () => {
    const html = `
      <dl>
        <dt>Title</dt><dd>Diesel Supply Contract</dd>
        <dt>Awardee</dt><dd>Petrojam Limited</dd>
        <dt>Total awarded amount</dt><dd>USD 1,250,000</dd>
      </dl>
    `;
    const out = parseDetailPage(html);
    assert.equal(out.awardee, 'Petrojam Limited');
    assert.equal(out.contractValue, 1_250_000);
    assert.equal(out.contractCurrency, 'USD');
  });

  it('extracts awardee from <th>/<td> table layout', () => {
    const html = `
      <table>
        <tr><th>Contractor</th><td>Acme Foods Ltd</td></tr>
        <tr><th>Contract value</th><td>500,000.00 EUR</td></tr>
      </table>
    `;
    const out = parseDetailPage(html);
    assert.equal(out.awardee, 'Acme Foods Ltd');
    assert.equal(out.contractValue, 500_000);
    assert.equal(out.contractCurrency, 'EUR');
  });

  it('returns nulls when fields are absent', () => {
    const html = '<html><body><h1>Notice details</h1><p>No awardee yet.</p></body></html>';
    const out = parseDetailPage(html);
    assert.equal(out.awardee, null);
    assert.equal(out.contractValue, null);
    assert.equal(out.contractCurrency, null);
  });

  it('handles label variations (Vendor, Supplier)', () => {
    const html = `
      <dl><dt>Vendor</dt><dd>Global Foods Inc</dd></dl>
    `;
    const out = parseDetailPage(html);
    assert.equal(out.awardee, 'Global Foods Inc');
  });
});

describe('UngmAwardsExtractor.streamAwards (fixture path)', () => {
  it('emits an award when search + detail both yield data', async () => {
    const fixture = {
      notices: [
        {
          Id: 999001,
          Title: 'WFP Diesel Supply Contract — Kenya',
          AgencyName: 'WFP',
          NoticeTypeName: 'Contract Award',
          PublishedDateUtc: '2024-09-15',
          Countries: [{ Name: 'Kenya' }],
          UNSPSCs: [{ Code: '15101505' }],
        },
      ],
      detailHtmlByNoticeId: {
        '999001': `
          <dl>
            <dt>Awardee</dt><dd>Kenya Petroleum Co.</dd>
            <dt>Awardee country</dt><dd>Kenya</dd>
            <dt>Total awarded amount</dt><dd>USD 850,000</dd>
          </dl>
        `,
      },
    };
    const extractor = new UngmAwardsExtractor({ fixture });
    const out = [];
    for await (const a of extractor.streamAwards()) out.push(a);
    assert.equal(out.length, 1);
    const first = out[0]!;
    assert.deepEqual(first.award.categoryTags, ['diesel']);
    assert.equal(first.award.contractValueNative, 850_000);
    assert.equal(first.award.buyerName, 'WFP');
    assert.equal(first.award.buyerCountry, 'KE');
    assert.equal(first.awardees[0]?.supplier.organisationName, 'Kenya Petroleum Co.');
  });

  it('skips notices without a parseable awardee on the detail page', async () => {
    const fixture = {
      notices: [
        {
          Id: 999002,
          Title: 'Food procurement RFP',
          AgencyName: 'WFP',
          NoticeTypeName: 'Contract Award',
          UNSPSCs: [{ Code: '50112000' }],
        },
      ],
      detailHtmlByNoticeId: {
        '999002': '<p>Detail page does not contain awardee information.</p>',
      },
    };
    const extractor = new UngmAwardsExtractor({ fixture });
    const out = [];
    for await (const a of extractor.streamAwards()) out.push(a);
    assert.equal(out.length, 0);
  });

  it('falls back to title-based classification when UNSPSC tagging is sparse', async () => {
    const fixture = {
      notices: [
        {
          Id: 999003,
          Title: 'Wheat flour procurement for school feeding programme',
          AgencyName: 'WFP',
          NoticeTypeName: 'Contract Award',
          UNSPSCs: [], // empty
        },
      ],
      detailHtmlByNoticeId: {
        '999003': '<dl><dt>Contractor</dt><dd>Cargill Inc</dd></dl>',
      },
    };
    const extractor = new UngmAwardsExtractor({ fixture });
    const out = [];
    for await (const a of extractor.streamAwards()) out.push(a);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.award.categoryTags, ['food-commodities']);
  });

  it('skips non-award notice types', async () => {
    const fixture = {
      notices: [
        {
          Id: 999004,
          Title: 'Open RFP for diesel supply',
          AgencyName: 'WFP',
          NoticeTypeName: 'Request for Proposal', // not an award
        },
      ],
    };
    const extractor = new UngmAwardsExtractor({ fixture });
    const out = [];
    for await (const a of extractor.streamAwards()) out.push(a);
    assert.equal(out.length, 0);
  });
});
