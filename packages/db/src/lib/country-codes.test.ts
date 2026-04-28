import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { m49ToIso2, EU27_ISO2, M49_TO_ISO2 } from './country-codes';

describe('m49ToIso2', () => {
  it('maps Libya (434) -> LY', () => {
    assert.equal(m49ToIso2(434), 'LY');
    assert.equal(m49ToIso2('434'), 'LY');
  });

  it('maps Italy (380) -> IT', () => {
    assert.equal(m49ToIso2(380), 'IT');
  });

  it('handles leading-zero codes', () => {
    assert.equal(m49ToIso2('008'), 'AL');
    assert.equal(m49ToIso2(8), 'AL'); // numeric loses leading zero
  });

  it('returns null for unknown codes', () => {
    assert.equal(m49ToIso2('999'), null);
    assert.equal(m49ToIso2(0), null);
  });
});

describe('EU27_ISO2', () => {
  it('contains the major EU member states', () => {
    assert.ok(EU27_ISO2.has('IT'));
    assert.ok(EU27_ISO2.has('DE'));
    assert.ok(EU27_ISO2.has('ES'));
    assert.ok(EU27_ISO2.has('FR'));
  });

  it('has exactly 27 members', () => {
    assert.equal(EU27_ISO2.size, 27);
  });

  it('does not include UK (post-Brexit)', () => {
    assert.equal(EU27_ISO2.has('GB'), false);
  });

  it('does not include Switzerland or Norway (non-EU)', () => {
    assert.equal(EU27_ISO2.has('CH'), false);
    assert.equal(EU27_ISO2.has('NO'), false);
  });
});

describe('M49_TO_ISO2 coverage', () => {
  it('covers the 50 most-relevant trade reporters', () => {
    const required = ['IT', 'ES', 'FR', 'DE', 'GR', 'HR', 'HU', 'AT', 'NL', 'BE',
                      'TR', 'GB', 'US', 'IN', 'CN', 'JP', 'KR', 'ID', 'TH', 'VN',
                      'PK', 'BD', 'LK', 'PH', 'MY', 'SG', 'NG', 'EG', 'ZA',
                      'BR', 'AR', 'MX', 'CL', 'PE', 'CO',
                      'SA', 'AE', 'KW', 'QA', 'OM',
                      'LY', 'DZ', 'TN', 'MA',
                      'RU', 'UA',
                      'AU', 'NZ', 'CA'];
    const have = new Set(Object.values(M49_TO_ISO2));
    for (const code of required) {
      assert.ok(have.has(code), `missing ISO-2 mapping: ${code}`);
    }
  });
});
