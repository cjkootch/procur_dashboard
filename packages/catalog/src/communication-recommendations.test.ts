import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateToMlEvidence,
  categorizeCandidate,
  COMMUNICATION_RECOMMENDATIONS_MODEL_VERSION,
  scoreFromBreakdown,
  type RecommendCandidate,
} from './communication-recommendations';

describe('scoreFromBreakdown', () => {
  it('sums positive + negative contributions', () => {
    assert.equal(
      scoreFromBreakdown({ role_match: 15, customs_flow: 10 }),
      25,
    );
  });

  it('clamps at 100', () => {
    assert.equal(
      scoreFromBreakdown({ a: 60, b: 60, c: 60 }),
      100,
    );
  });

  it('clamps at 0 when sanctions block dominates', () => {
    assert.equal(
      scoreFromBreakdown({
        graph_similarity: 25,
        role_match: 15,
        sanctions_warning: -100,
      }),
      0,
    );
  });
});

describe('categorizeCandidate', () => {
  it('compliance_blocked is sticky regardless of score', () => {
    assert.equal(
      categorizeCandidate(
        { role_match: 15, customs_flow: 10, sanctions_warning: -100 },
        'compliance_blocked',
      ),
      'compliance_blocked',
    );
  });

  it('outreach_ready when score >= 30 + at least one explicit evidence', () => {
    assert.equal(
      categorizeCandidate(
        { role_match: 15, customs_flow: 10, fuel_consumption_signal: 10 },
        'outreach_ready',
      ),
      'outreach_ready',
    );
  });

  it('research_target when only ML similarity (no explicit evidence)', () => {
    // ML similarity alone — even at high score — is inference, not
    // validation. Forces operator diligence before outreach.
    assert.equal(
      categorizeCandidate({ graph_similarity: 30 }, 'outreach_ready'),
      'research_target',
    );
  });

  it('research_target when ML + apollo contact (still no validation)', () => {
    assert.equal(
      categorizeCandidate(
        { graph_similarity: 30, attribute_prediction: 8, apollo_contact: 5 },
        'outreach_ready',
      ),
      'research_target',
    );
  });

  it('research_target when explicit evidence but score < 30', () => {
    assert.equal(
      categorizeCandidate({ category_match: 10 }, 'outreach_ready'),
      'research_target',
    );
  });
});

describe('candidateToMlEvidence', () => {
  it('packages candidate evidence with the current model version', () => {
    const candidate: RecommendCandidate = {
      entitySlug: 'acme',
      entityName: 'Acme',
      recommendedChannel: 'email',
      score: 55,
      scoreBreakdown: { role_match: 15, customs_flow: 10 },
      evidenceItems: [
        {
          kind: 'role_match',
          sourceId: 'acme',
          confidence: 1,
          summary: 'Role: refiner',
        },
      ],
      risks: [],
      nextBestAction: 'outreach_ready',
      doNotMention: [],
    };
    const evidence = candidateToMlEvidence(candidate);
    assert.equal(
      evidence.modelVersion,
      COMMUNICATION_RECOMMENDATIONS_MODEL_VERSION,
    );
    assert.equal(evidence.totalScore, 55);
    assert.equal(evidence.items.length, 1);
    assert.equal(evidence.items[0]?.kind, 'role_match');
  });
});
