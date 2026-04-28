import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfText } from './extractor';

/**
 * Pure-text parser tests. The HTTP + PDF-decode chain is validated by
 * the per-PR smoke run against neon — reproducing it offline would
 * require shipping real PDFs as fixtures, which we deliberately don't.
 */

const SAMPLE_AWARD_NOTICE = `
Contract Award Notice
Resource: 12345
Procuring entity: Jamaica Defence Force

Description: Supply and delivery of automotive diesel fuel

CPV codes:
  09134200-Diesel fuel
  09134100-Gas oils

Name of contractor (1)
Petrojam Limited

Contract price
   45,250,000.00   Currency: JMD

Contract award date
Date: 15/06/2024
`;

describe('parsePdfText', () => {
  it('extracts awardee from "Name of contractor" block', () => {
    const out = parsePdfText(SAMPLE_AWARD_NOTICE);
    assert.equal(out.awardee, 'Petrojam Limited');
  });

  it('extracts CPV codes (deduped) from the codes block', () => {
    const out = parsePdfText(SAMPLE_AWARD_NOTICE);
    assert.deepEqual([...out.cpvCodes].sort(), ['09134100', '09134200']);
  });

  it('extracts contract price + currency', () => {
    const out = parsePdfText(SAMPLE_AWARD_NOTICE);
    assert.equal(out.contractPrice, 45_250_000);
    assert.equal(out.currency, 'JMD');
  });

  it('extracts award date in dd/MM/yyyy form', () => {
    const out = parsePdfText(SAMPLE_AWARD_NOTICE);
    assert.equal(out.awardDate, '15/06/2024');
  });

  it('returns empty/undefined for malformed input', () => {
    const out = parsePdfText('garbage with no fields');
    assert.equal(out.awardee, undefined);
    assert.deepEqual(out.cpvCodes, []);
    assert.equal(out.contractPrice, undefined);
  });

  it('handles missing optional fields gracefully', () => {
    const out = parsePdfText(`
Name of contractor (1)
Solo Awardee Ltd
`);
    assert.equal(out.awardee, 'Solo Awardee Ltd');
    assert.deepEqual(out.cpvCodes, []);
    assert.equal(out.contractPrice, undefined);
    assert.equal(out.currency, undefined);
    assert.equal(out.awardDate, undefined);
  });
});
