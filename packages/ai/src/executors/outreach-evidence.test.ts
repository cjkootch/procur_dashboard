import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutreachMetadata,
  hasOutreachEvidence,
  parseOutreachEvidence,
  type OutreachEvidence,
} from './outreach-evidence';

describe('outreach-evidence helpers', () => {
  it('parseOutreachEvidence ignores unrelated payload fields', () => {
    const result = parseOutreachEvidence({
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
      rationale: 'r',
    });
    assert.deepEqual(result, {});
    assert.equal(hasOutreachEvidence(result), false);
  });

  it('parseOutreachEvidence reads sourceEntitySlug + sourceSignalId', () => {
    const result = parseOutreachEvidence({
      sourceEntitySlug: 'acme',
      sourceSignalId: 'sig_1',
    });
    assert.equal(result.sourceEntitySlug, 'acme');
    assert.equal(result.sourceSignalId, 'sig_1');
    assert.equal(hasOutreachEvidence(result), true);
  });

  it('parseOutreachEvidence requires mlEvidence to have modelVersion + items array', () => {
    const valid = parseOutreachEvidence({
      mlEvidence: { modelVersion: 'v1', items: [{ kind: 'role_match' }] },
    });
    assert.ok(valid.mlEvidence);
    const invalid = parseOutreachEvidence({
      mlEvidence: { items: [{ kind: 'role_match' }] }, // missing modelVersion
    });
    assert.equal(invalid.mlEvidence, undefined);
  });

  it('parseOutreachEvidence drops non-string riskWarnings', () => {
    const result = parseOutreachEvidence({
      riskWarnings: ['Real warning', 42, null, 'Another warning'],
    });
    assert.deepEqual(result.riskWarnings, ['Real warning', 'Another warning']);
  });

  it('buildOutreachMetadata returns {} for no-evidence input', () => {
    assert.deepEqual(buildOutreachMetadata({}), {});
  });

  it('buildOutreachMetadata maps mlEvidence.items to ml_evidence.item_ids', () => {
    const evidence: OutreachEvidence = {
      sourceEntitySlug: 'acme',
      mlEvidence: {
        modelVersion: 'comm-rec-v1',
        totalScore: 65,
        items: [
          {
            kind: 'graph_similarity',
            sourceId: 'seed:acme',
            confidence: 0.82,
            summary: 'Graph-similar',
          },
          {
            kind: 'role_match',
            sourceId: 'acme:role',
            confidence: 1,
            summary: 'Role: refiner',
          },
        ],
      },
    };
    const metadata = buildOutreachMetadata(evidence);
    const ml = metadata['ml_evidence'] as Record<string, unknown>;
    assert.equal(ml.model_version, 'comm-rec-v1');
    assert.equal(ml.total_score, 65);
    assert.deepEqual(ml.item_ids, ['seed:acme', 'acme:role']);
    const source = metadata['outreach_source'] as Record<string, unknown>;
    assert.equal(source.entity_slug, 'acme');
  });

  it('buildOutreachMetadata preserves riskWarnings + doNotMention', () => {
    const metadata = buildOutreachMetadata({
      sourceEntitySlug: 'acme',
      riskWarnings: ['Recent bounce'],
      doNotMention: ['ML score'],
    });
    assert.deepEqual(metadata['risk_warnings'], ['Recent bounce']);
    assert.deepEqual(metadata['do_not_mention'], ['ML score']);
  });
});
