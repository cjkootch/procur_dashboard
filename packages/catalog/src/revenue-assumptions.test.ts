import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_ASSUMPTION_GENERATOR_VERSION,
  type GeneratedAssumption,
} from './revenue-assumptions';

describe('REVENUE_ASSUMPTION_GENERATOR_VERSION', () => {
  it('is a stable string the executor + dashboard can pivot on', () => {
    assert.equal(typeof REVENUE_ASSUMPTION_GENERATOR_VERSION, 'string');
    assert.match(REVENUE_ASSUMPTION_GENERATOR_VERSION, /^gen-v\d+$/);
  });
});

describe('GeneratedAssumption shape', () => {
  it('round-trips a hand-crafted assumption', () => {
    const a: GeneratedAssumption = {
      assumptionType: 'authority',
      assumptionText: 'Procurement Director has buying authority',
      confidenceScore: 65,
      fastestTest: 'Email asking for procurement role + decision-maker',
      riskIfFalse: 'We pitch into a non-decisionmaker and the deal stalls',
      recommendedActionType: 'email.send',
    };
    assert.equal(a.assumptionType, 'authority');
    assert.equal(a.confidenceScore, 65);
    assert.equal(a.recommendedActionType, 'email.send');
  });

  it('allows recommendedActionType: null when no action fits', () => {
    const a: GeneratedAssumption = {
      assumptionType: 'logistics',
      assumptionText: 'Cargo can discharge at Varreux within laycan',
      confidenceScore: 55,
      fastestTest: 'Confirm vessel availability with port agent',
      riskIfFalse: 'Cargo cannot land within window',
      recommendedActionType: null,
    };
    assert.equal(a.recommendedActionType, null);
  });
});
