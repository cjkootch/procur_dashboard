import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertToUsd, isSupportedCurrency } from './fx';

describe('convertToUsd', () => {
  it('round-trips USD unchanged', () => {
    assert.equal(convertToUsd(1000, 'USD', '2024-01-15'), 1000);
    assert.equal(convertToUsd(1000, 'usd', '2024-01-15'), 1000);
  });

  it('converts DOP to USD using monthly rate when available', () => {
    // 'DOP-2024-06': 1 / 58.9, so 5_890_000 DOP ≈ 100_000 USD
    const usd = convertToUsd(5_890_000, 'DOP', '2024-06-15');
    assert.ok(usd != null);
    assert.ok(usd > 99_000 && usd < 101_000, `expected ~100k USD, got ${usd}`);
  });

  it('falls back to baseline rate for off-month dates', () => {
    // 'DOP-2024-09' isn't in the table — should use baseline 1/58
    const usd = convertToUsd(58_000, 'DOP', '2024-09-15');
    assert.ok(usd != null);
    // baseline 1/58 → 1000 USD
    assert.ok(usd > 990 && usd < 1010);
  });

  it('returns null for unknown currency', () => {
    assert.equal(convertToUsd(1000, 'EUR', '2024-01-15'), null);
    assert.equal(convertToUsd(1000, 'XYZ', '2024-01-15'), null);
  });

  it('returns null for null/undefined inputs', () => {
    assert.equal(convertToUsd(null, 'USD', '2024-01-15'), null);
    assert.equal(convertToUsd(undefined, 'USD', '2024-01-15'), null);
    assert.equal(convertToUsd(1000, null, '2024-01-15'), null);
    assert.equal(convertToUsd(1000, '', '2024-01-15'), null);
  });

  it('handles unparseable dates by falling back to baseline', () => {
    const usd = convertToUsd(58_000, 'DOP', 'not-a-date');
    assert.ok(usd != null && usd > 990 && usd < 1010);
  });

  it('converts JMD using monthly rate', () => {
    // 'JMD-2024-06': 1 / 156.5, so 1_565_000 JMD ≈ 10_000 USD
    const usd = convertToUsd(1_565_000, 'JMD', '2024-06-15');
    assert.ok(usd != null && usd > 9_900 && usd < 10_100);
  });
});

describe('isSupportedCurrency', () => {
  it('returns true for known currencies', () => {
    assert.equal(isSupportedCurrency('USD'), true);
    assert.equal(isSupportedCurrency('DOP'), true);
    assert.equal(isSupportedCurrency('JMD'), true);
    assert.equal(isSupportedCurrency('jmd'), true);
  });

  it('returns false for unknown / null', () => {
    assert.equal(isSupportedCurrency('EUR'), false);
    assert.equal(isSupportedCurrency(null), false);
    assert.equal(isSupportedCurrency(undefined), false);
  });
});
