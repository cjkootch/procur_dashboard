import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAwardByUnspsc,
  FUEL_UNSPSC_CODES,
  hasFuelUnspsc,
  hasFoodUnspsc,
} from './awards-classifier';

describe('classifyAwardByUnspsc', () => {
  it('emits diesel for diesel-fuel UNSPSC codes', () => {
    assert.deepEqual(classifyAwardByUnspsc(['15101505']), ['diesel']);
    assert.deepEqual(classifyAwardByUnspsc(['15101506']), ['diesel']);
  });

  it('emits gasoline + diesel as a deduped union for mixed awards', () => {
    const tags = classifyAwardByUnspsc(['15101505', '15101503']);
    assert.deepEqual([...tags].sort(), ['diesel', 'gasoline']);
  });

  it('emits jet-fuel for the kerosene aviation classes', () => {
    assert.deepEqual(classifyAwardByUnspsc(['15101504']), ['jet-fuel']);
    assert.deepEqual(classifyAwardByUnspsc(['15101508']), ['jet-fuel']);
    assert.deepEqual(classifyAwardByUnspsc(['15101510']), ['jet-fuel']);
  });

  it('emits crude-oil for class 1510.17', () => {
    assert.deepEqual(classifyAwardByUnspsc(['15101701']), ['crude-oil']);
  });

  it('emits food-commodities for family 50 codes', () => {
    assert.deepEqual(classifyAwardByUnspsc(['50121500']), ['food-commodities']);
    assert.deepEqual(classifyAwardByUnspsc(['50202300']), ['food-commodities']);
  });

  it('emits vehicles for the 2510 motor-vehicles family', () => {
    assert.deepEqual(classifyAwardByUnspsc(['25101500']), ['vehicles']);
  });

  it('emits minerals-metals only for 1110 + 3010 prefixes', () => {
    assert.deepEqual(classifyAwardByUnspsc(['11101500']), ['minerals-metals']);
    assert.deepEqual(classifyAwardByUnspsc(['30101500']), ['minerals-metals']);
    // Sibling families inside Segment 11 (textile, plant) should NOT match
    assert.deepEqual(classifyAwardByUnspsc(['11151500']), []);
  });

  it('returns empty array for codes outside any mapped family', () => {
    assert.deepEqual(classifyAwardByUnspsc(['72101500']), []); // construction services
    assert.deepEqual(classifyAwardByUnspsc([]), []);
    assert.deepEqual(classifyAwardByUnspsc(['']), []);
  });

  it('tolerates dots and dashes in input codes', () => {
    assert.deepEqual(classifyAwardByUnspsc(['15-10-15-05']), ['diesel']);
    assert.deepEqual(classifyAwardByUnspsc(['1510.15.05']), ['diesel']);
  });
});

describe('FUEL_UNSPSC_CODES', () => {
  it('matches the Python caribbean_fuel set (12 fuel codes + crude class)', () => {
    // Python script's set has 14 codes total (12 fuel + 2 crude).
    assert.equal(FUEL_UNSPSC_CODES.size, 14);
  });

  it('contains the canonical diesel + gasoline codes', () => {
    assert.ok(FUEL_UNSPSC_CODES.has('15101505'));
    assert.ok(FUEL_UNSPSC_CODES.has('15101506'));
    assert.ok(FUEL_UNSPSC_CODES.has('15101503'));
  });
});

describe('hasFuelUnspsc / hasFoodUnspsc', () => {
  it('hasFuelUnspsc returns true if any code is fuel', () => {
    assert.equal(hasFuelUnspsc(['72101500', '15101505']), true);
    assert.equal(hasFuelUnspsc(['72101500']), false);
    assert.equal(hasFuelUnspsc([]), false);
  });

  it('hasFoodUnspsc matches family 10 + 50 prefixes', () => {
    assert.equal(hasFoodUnspsc(['50121500']), true);
    assert.equal(hasFoodUnspsc(['10101500']), true);
    assert.equal(hasFoodUnspsc(['72101500']), false);
  });
});
