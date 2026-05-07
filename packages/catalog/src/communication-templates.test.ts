import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { substitute } from './communication-templates';

describe('substitute', () => {
  it('replaces named placeholders', () => {
    assert.equal(
      substitute('Hi {{name}}, welcome to {{company}}.', {
        name: 'Alice',
        company: 'Acme',
      }),
      'Hi Alice, welcome to Acme.',
    );
  });

  it('tolerates whitespace inside braces', () => {
    assert.equal(
      substitute('Hi {{ name }}.', { name: 'Alice' }),
      'Hi Alice.',
    );
  });

  it('handles positional placeholders for whatsapp_template', () => {
    assert.equal(
      substitute('Welcome {{1}} from {{2}}.', { '1': 'Alice', '2': 'Acme' }),
      'Welcome Alice from Acme.',
    );
  });

  it('passes through unknown placeholders', () => {
    // Easier to spot in a draft than a silent empty slot.
    assert.equal(
      substitute('Hi {{name}}, {{unknown}} please review.', {
        name: 'Alice',
      }),
      'Hi Alice, {{unknown}} please review.',
    );
  });

  it('escapes nothing — adjacent placeholders work', () => {
    assert.equal(
      substitute('{{a}}{{b}}', { a: 'x', b: 'y' }),
      'xy',
    );
  });

  it('returns input unchanged when no placeholders present', () => {
    assert.equal(substitute('plain text', { a: 'x' }), 'plain text');
  });
});
