import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubAddressedEmail,
  parseSubAddressToken,
} from './lead-form-submission-tokens';

describe('lead-form sub-address tokens — build/parse symmetry', () => {
  it('round-trips a token through build + parse', () => {
    const built = buildSubAddressedEmail('hello@procur.app', 'abc23456');
    assert.equal(built, 'hello+abc23456@procur.app');
    assert.equal(parseSubAddressToken(built), 'abc23456');
  });

  it('parses token from a To: address with display name + angle brackets', () => {
    const headerForm = '"Procur Outreach" <hello+xyz77abc@procur.app>';
    assert.equal(parseSubAddressToken(headerForm), 'xyz77abc');
  });

  it('returns null for bare addresses with no plus suffix', () => {
    assert.equal(parseSubAddressToken('hello@procur.app'), null);
    assert.equal(parseSubAddressToken('"Procur" <hello@procur.app>'), null);
  });

  it('returns null for malformed addresses', () => {
    assert.equal(parseSubAddressToken('not-an-email'), null);
    assert.equal(parseSubAddressToken(''), null);
  });

  it('handles uppercase token characters via lowercase normalization', () => {
    // Operator misconfig or mail relay re-casing — accept gracefully.
    assert.equal(
      parseSubAddressToken('hello+ABC23456@PROCUR.APP'),
      'abc23456',
    );
  });

  it('preserves the local-part on build when sender has multiple dots', () => {
    assert.equal(
      buildSubAddressedEmail('lead.form@procur.app', 'def45678'),
      'lead.form+def45678@procur.app',
    );
  });

  it('falls back to bare email when the input is not a valid email', () => {
    // Defensive — env misconfig shouldn't crash the autopilot.
    assert.equal(
      buildSubAddressedEmail('not-an-email', 'abc23456'),
      'not-an-email',
    );
  });
});
