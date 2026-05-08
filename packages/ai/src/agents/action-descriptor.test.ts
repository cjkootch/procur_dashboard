import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActionDescriptor } from './action-descriptor';

describe('ActionDescriptor — communication variants ML evidence fields', () => {
  it('email.send accepts rationale + evidence pack', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'email.send',
      tier: 'T2',
      to: ['alice@example.com'],
      subject: 'Q3 supply',
      body: 'Hi Alice, can we talk Q3?',
      rationale: 'Recent customs activity suggests demand spike',
      sourceEntitySlug: 'acme-trading',
      sourceSignalId: 'sig_01HW...',
      mlEvidence: {
        modelVersion: 'comm-rec-v1',
        totalScore: 65,
        items: [
          {
            kind: 'graph_similarity',
            sourceId: 'seed:acme-trading',
            confidence: 0.82,
            summary: 'Graph-similar to Vitol',
          },
        ],
      },
      evidenceJson: { score_breakdown: { graph_similarity: 25 } },
      riskWarnings: [],
      doNotMention: ['ML similarity score'],
    });
    assert.equal(result.success, true);
  });

  it('sms.send accepts evidence pack', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'sms.send',
      tier: 'T2',
      to: '+18324927169',
      body: 'Quick Q on Q3 spec',
      rationale: 'Following customs jump',
      sourceEntitySlug: 'acme-trading',
      mlEvidence: {
        modelVersion: 'comm-rec-v1',
        items: [
          {
            kind: 'role_match',
            sourceId: 'acme-trading',
            confidence: 1,
            summary: 'Role: refiner',
          },
        ],
      },
    });
    assert.equal(result.success, true);
  });

  it('outbound_call accepts evidence pack', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'outbound_call',
      tier: 'T3',
      contactId: '01HW0000000000000000000000',
      orgId: '01HW0000000000000000000001',
      toNumber: '+18324927169',
      rationale: 'Discuss Q3',
      goalHint: 'Pin down loading window',
      sourceEntitySlug: 'acme-trading',
    });
    assert.equal(result.success, true);
  });

  it('outbound_call accepts voicemailMode + voicemailMessage', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'outbound_call',
      tier: 'T3',
      toNumber: '+18324927169',
      rationale: 'Voicemail test',
      voicemailMode: true,
      voicemailMessage:
        'Hi Cole, this is a test call from the Procur AI assistant. ' +
        'You can disregard this message.',
    });
    assert.equal(result.success, true);
  });

  it('whatsapp.send_template accepts evidence pack', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'whatsapp.send_template',
      tier: 'T2',
      to: '+18324927169',
      contentSid: 'HX' + 'a'.repeat(32),
      rationale: 'Template intro outside 24h window',
      sourceEntitySlug: 'acme-trading',
      mlEvidence: {
        modelVersion: 'comm-rec-v1',
        items: [
          {
            kind: 'apollo_contact',
            sourceId: 'apollo:123',
            confidence: 0.8,
            summary: 'Apollo contact resolved',
          },
        ],
      },
    });
    assert.equal(result.success, true);
  });

  it('rejects mlEvidence with empty items array', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'email.send',
      tier: 'T2',
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
      rationale: 'r',
      mlEvidence: {
        modelVersion: 'v1',
        items: [],
      },
    });
    assert.equal(result.success, false);
  });

  it('rejects evidence item with confidence > 1', () => {
    const result = ActionDescriptor.safeParse({
      kind: 'email.send',
      tier: 'T2',
      to: ['a@x.com'],
      subject: 's',
      body: 'b',
      rationale: 'r',
      mlEvidence: {
        modelVersion: 'v1',
        items: [
          {
            kind: 'role_match',
            sourceId: 'x',
            confidence: 1.5,
            summary: 'too confident',
          },
        ],
      },
    });
    assert.equal(result.success, false);
  });
});
