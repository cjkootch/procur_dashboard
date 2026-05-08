import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCountryTimezone,
  isWithinQuietHours,
} from './country-timezone';

describe('resolveCountryTimezone', () => {
  it('maps known countries to their primary IANA timezone', () => {
    assert.equal(resolveCountryTimezone('US'), 'America/New_York');
    assert.equal(resolveCountryTimezone('JP'), 'Asia/Tokyo');
    assert.equal(resolveCountryTimezone('GB'), 'Europe/London');
    assert.equal(resolveCountryTimezone('SG'), 'Asia/Singapore');
    assert.equal(resolveCountryTimezone('AU'), 'Australia/Sydney');
    assert.equal(resolveCountryTimezone('BB'), 'America/Barbados');
  });

  it('lowercases and trims input', () => {
    assert.equal(resolveCountryTimezone('  jp  '), 'Asia/Tokyo');
    assert.equal(resolveCountryTimezone('us'), 'America/New_York');
  });

  it('falls back to UTC for unknown / null / empty', () => {
    assert.equal(resolveCountryTimezone(null), 'UTC');
    assert.equal(resolveCountryTimezone(undefined), 'UTC');
    assert.equal(resolveCountryTimezone(''), 'UTC');
    assert.equal(resolveCountryTimezone('XX'), 'UTC');
    assert.equal(resolveCountryTimezone('ZZ'), 'UTC');
  });
});

describe('isWithinQuietHours', () => {
  it('default 8am-6pm window: 11am Tokyo time = allowed', () => {
    // Pick a UTC time that's clearly 11am in Tokyo (UTC+9 standard).
    const utc11amTokyo = new Date('2026-05-08T02:00:00Z');
    const result = isWithinQuietHours({
      country: 'JP',
      now: utc11amTokyo,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.recipientHour, 11);
    assert.equal(result.timezone, 'Asia/Tokyo');
  });

  it('default 8am-6pm window: 7am Tokyo time = blocked', () => {
    const utc7amTokyo = new Date('2026-05-08T22:00:00Z'); // prev UTC day
    const result = isWithinQuietHours({
      country: 'JP',
      now: utc7amTokyo,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.recipientHour, 7);
  });

  it('default 8am-6pm window: 6pm Tokyo time = blocked (exclusive end)', () => {
    const utc6pmTokyo = new Date('2026-05-08T09:00:00Z');
    const result = isWithinQuietHours({
      country: 'JP',
      now: utc6pmTokyo,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.recipientHour, 18);
  });

  it('default 8am-6pm window: 5pm Tokyo time = allowed', () => {
    const utc5pmTokyo = new Date('2026-05-08T08:00:00Z');
    const result = isWithinQuietHours({
      country: 'JP',
      now: utc5pmTokyo,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.recipientHour, 17);
  });

  it('respects custom window override', () => {
    // 9am-5pm window: 8am should now block (was allowed at default).
    const utc8amTokyo = new Date('2026-05-07T23:00:00Z');
    const result = isWithinQuietHours({
      country: 'JP',
      startHour: 9,
      endHour: 17,
      now: utc8amTokyo,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.recipientHour, 8);
  });

  it('unknown country evaluates against UTC', () => {
    // 10am UTC, unknown country.
    const utc10am = new Date('2026-05-08T10:00:00Z');
    const result = isWithinQuietHours({
      country: 'XX',
      now: utc10am,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.recipientHour, 10);
    assert.equal(result.timezone, 'UTC');
  });
});
