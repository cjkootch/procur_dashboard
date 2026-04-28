import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDrDgcpYearUrl, getDefaultLookbackYears } from './download';

describe('getDrDgcpYearUrl', () => {
  it('builds the OCDR per-year download URL', () => {
    assert.equal(
      getDrDgcpYearUrl(2025),
      'https://data.open-contracting.org/en/publication/22/download?name=2025.jsonl.gz',
    );
  });

  it('rejects non-integer or out-of-range years', () => {
    assert.throws(() => getDrDgcpYearUrl(2025.5));
    assert.throws(() => getDrDgcpYearUrl(1999));
    assert.throws(() => getDrDgcpYearUrl(2200));
  });
});

describe('getDefaultLookbackYears', () => {
  it('returns the current year + previous N-1 years, newest first', () => {
    const asOf = new Date(Date.UTC(2026, 5, 15)); // mid-June 2026
    assert.deepEqual(getDefaultLookbackYears(5, asOf), [2026, 2025, 2024, 2023, 2022]);
  });

  it('handles a single-year lookback', () => {
    const asOf = new Date(Date.UTC(2026, 0, 1));
    assert.deepEqual(getDefaultLookbackYears(1, asOf), [2026]);
  });

  it('defaults to 5 years', () => {
    const asOf = new Date(Date.UTC(2026, 0, 1));
    assert.equal(getDefaultLookbackYears(undefined, asOf).length, 5);
  });
});
