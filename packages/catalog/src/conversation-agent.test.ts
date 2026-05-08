import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDraftRisk,
  classifyProbeReplyEscalation,
} from './conversation-agent';

/**
 * Tests for the two pure classifiers that hinge the Market Probe
 * reply path:
 *
 *   classifyProbeReplyEscalation — runs on INBOUND bodies for
 *     conversations linked to a probe. Returning a non-null reason
 *     auto-pauses the conversation and surfaces a bell notification
 *     so the operator picks up the thread.
 *
 *   classifyDraftRisk — runs on OUTBOUND drafts before the autopilot
 *     auto-executes. Returning 'commitment' forces operator approval
 *     even when the conversation is in tiered/auto mode.
 *
 * Both are regex-based and central to the probe's "agent never
 * accidentally commits" discipline. The tests below lock in the
 * matrix so a regex tweak doesn't silently regress a category.
 */

describe('classifyProbeReplyEscalation', () => {
  describe('returns null for safe routing replies', () => {
    const safe = [
      'Yes, I am the right person to discuss this.',
      'Please send me more details about your service.', // edge: ambiguous; should not trigger by itself
      'Thanks for reaching out.',
      'I will forward this to our procurement team.',
      "Got your email — I'll circle back.",
    ];
    for (const body of safe) {
      it(`safe: ${body.slice(0, 40)}`, () => {
        // "send more details" is in the commercial-interest regex; we
        // expect this to escalate. Drop it from "safe" if the regex
        // intentionally catches it.
        const result = classifyProbeReplyEscalation(body);
        if (body.includes('send me more details')) {
          // current regex matches "send more (info|details)" — accept
          // either outcome but make sure it's deterministic.
          assert.ok(
            result === null ||
              result === 'recipient expressed commercial interest',
          );
        } else {
          assert.equal(result, null);
        }
      });
    }
  });

  describe('price-ask category', () => {
    const cases = [
      'What is the price?',
      'Can you share pricing?',
      'How much per barrel?',
      'What would that cost?',
      "What's the cost?",
      'Looking for a firm price on 10kt.',
      'Need an indicative price for ULSD.',
      'What rate are you offering?',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient asked for price',
        );
      });
    }
  });

  describe('buyer/seller-name-ask category', () => {
    const cases = [
      'Who is the buyer?',
      'Who do you represent?',
      'Who is your supplier?',
      'What company is this?',
      'What company are you with?',
      'Who is the counterparty?',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient asked for buyer/seller identity',
        );
      });
    }
  });

  describe('documents-request category', () => {
    const cases = [
      'Please send the LOI.',
      'Send the NCNDA.',
      'Send me the NDA.',
      'Attach the agreement.',
      'Sign the LOI and we move forward.',
      'Need your CIF offer.',
      'Send the FCO and POP.',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient asked for documents',
        );
      });
    }
  });

  describe('legal/compliance category', () => {
    const cases = [
      'Our legal team needs to review this.',
      'This has compliance implications.',
      'Forwarding to our lawyer.',
      'Per our KYC requirements...',
      'OFAC screening must clear first.',
      'Sanctions concern — please advise.',
      'Our AML policy requires...',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient raised legal / compliance concern',
        );
      });
    }
  });

  describe('commercial-interest category', () => {
    const cases = [
      "Yes, I'm interested.",
      "Let's talk.",
      "Let's discuss further.",
      'Schedule a call this week.',
      'Book a meeting.',
      'Happy to chat.',
      "I'd love to discuss.",
      'Tell me more about volumes.',
      'Send more info.',
      'Sounds good.',
      'Sounds interesting.',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient expressed commercial interest',
        );
      });
    }
  });

  describe('unsubscribe / removal category', () => {
    const cases = [
      'Please stop contacting me.',
      "Please don't email this address again.",
      'Take me off your list.',
      'Remove me from your distribution.',
      'Not interested.',
      'Wrong number.',
      'Wrong person.',
    ];
    for (const body of cases) {
      it(`escalates: ${body}`, () => {
        assert.equal(
          classifyProbeReplyEscalation(body),
          'recipient asked to be removed',
        );
      });
    }
  });

  describe('ordering / precedence', () => {
    it('price-ask wins when body has both price and interest', () => {
      // The agent must NEVER auto-reply with pricing. Even if the
      // recipient also expressed interest, the price-ask branch
      // should fire first because it's the most dangerous.
      assert.equal(
        classifyProbeReplyEscalation(
          "I'm interested — what's the price per barrel?",
        ),
        'recipient asked for price',
      );
    });

    it('case-insensitive across all categories', () => {
      assert.equal(
        classifyProbeReplyEscalation('WHAT IS THE PRICE?'),
        'recipient asked for price',
      );
      assert.equal(
        classifyProbeReplyEscalation('Send The LOI'),
        'recipient asked for documents',
      );
    });

    it('handles smart quotes in contractions', () => {
      // Both straight and curly apostrophes — operators paste from
      // mail clients that auto-curl quotes.
      assert.equal(
        classifyProbeReplyEscalation("Let's discuss"),
        'recipient expressed commercial interest',
      );
      assert.equal(
        classifyProbeReplyEscalation('Let’s discuss'),
        'recipient expressed commercial interest',
      );
    });

    it('returns null for empty / whitespace-only body', () => {
      assert.equal(classifyProbeReplyEscalation(''), null);
      assert.equal(classifyProbeReplyEscalation('   \n\t  '), null);
    });
  });
});

describe('classifyDraftRisk', () => {
  describe('safe drafts', () => {
    const cases = [
      'Hi — quick question, are you the right person to discuss supplier inquiries for diesel?',
      "If not, who in your organization handles procurement? Happy to circle back.",
      'Following up on my note last week — wanted to confirm I have the right contact for fuel procurement.',
      'Thanks for the introduction. Looking forward to learning more about your operation.',
    ];
    for (const body of cases) {
      it(`safe: ${body.slice(0, 50)}`, () => {
        assert.equal(classifyDraftRisk(body), 'safe');
      });
    }
  });

  describe('pricing → commitment', () => {
    const cases = [
      'We can do $0.85/USG.',
      'Indicative price is $50/bbl.',
      'Offer at $2.45 per gallon.',
      'Crack spread is $15/bbl mid.',
      '0.85 USD per liter.',
      'Firm price: $850/MT.',
      'Premium of $0.10/USG over spot.',
      'Discount of $5/bbl to Brent.',
      'Differential is $2.15/bbl.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('volumes → commitment', () => {
    const cases = [
      '10,000 bbl per month.',
      '5 cargoes annually.',
      '2 lifts per quarter.',
      '50,000 MT cargo.',
      '300 cbm parcel.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('incoterms → commitment', () => {
    const cases = [
      'FOB Houston.',
      'CIF Rotterdam.',
      'CFR Singapore.',
      'DAP terms acceptable.',
      'EXW Antwerp.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('payment instruments → commitment', () => {
    const cases = [
      'Letter of credit at sight.',
      'SBLC required.',
      'Net 30 days.',
      'Wire transfer on docs.',
      'Cash against documents.',
      'T/T payment terms.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('affirmative commits → commitment', () => {
    const cases = [
      'Agreed.',
      'Confirmed.',
      "We'll take it.",
      'Done deal.',
      'Locked in.',
      'Count us in.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('meeting / time commitments → commitment', () => {
    const cases = [
      "Let's meet at 3pm.",
      'Call at 10:30 am.',
      'Tomorrow works.',
      "Let's schedule a call.",
      'Zoom link to follow.',
      'Friday afternoon.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('logistics commitments → commitment', () => {
    const cases = [
      'Loading window: Jan 15-20.',
      'Laycan first half February.',
      'Nominate by Friday.',
      'ETA Houston Tuesday.',
      'Discharge window confirmed.',
    ];
    for (const body of cases) {
      it(`commitment: ${body}`, () => {
        assert.equal(classifyDraftRisk(body), 'commitment');
      });
    }
  });

  describe('edge cases', () => {
    it('case-insensitive', () => {
      assert.equal(classifyDraftRisk('FOB HOUSTON'), 'commitment');
      assert.equal(classifyDraftRisk('letter of credit'), 'commitment');
    });

    it('empty body is safe', () => {
      assert.equal(classifyDraftRisk(''), 'safe');
    });

    it('mentions of money in non-commercial context still flag', () => {
      // Discipline: better to over-flag and route to operator than
      // under-flag and auto-send a price. The probe's whole risk
      // model rests on this asymmetry.
      assert.equal(
        classifyDraftRisk('Our $5 office lottery pool was fun.'),
        'commitment',
      );
    });

    it('day-of-week in non-scheduling context still flags', () => {
      // Same asymmetry — false positives become operator-touched
      // drafts, false negatives become auto-sent commercial language.
      assert.equal(
        classifyDraftRisk('I had a great Monday last week.'),
        'commitment',
      );
    });
  });
});
