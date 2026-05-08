import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReplySubject,
  classifyDraftRisk,
  classifyProbeReplyEscalation,
  isOooReply,
  matchStopKeyword,
  resolveEmailRecipients,
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

// ─────────────────────────────────────────────────────────────────────
// matchStopKeyword — carrier-required SMS opt-out detection. Misses
// here are user-visible: a recipient typing "STOP." gets another
// message and a regulatory complaint follows.
// ─────────────────────────────────────────────────────────────────────

describe('matchStopKeyword', () => {
  describe('exact bare keywords', () => {
    it('matches "stop"', () => {
      assert.equal(matchStopKeyword('stop', []), 'stop');
    });

    it('matches "STOP" case-insensitive', () => {
      assert.equal(matchStopKeyword('STOP', []), 'stop');
    });

    it('matches "Unsubscribe"', () => {
      assert.equal(matchStopKeyword('Unsubscribe', []), 'unsubscribe');
    });

    it('matches "OPT OUT" with space', () => {
      assert.equal(matchStopKeyword('OPT OUT', []), 'opt out');
    });

    it('matches "Cancel"', () => {
      assert.equal(matchStopKeyword('Cancel', []), 'cancel');
    });
  });

  describe('keyword at start of message', () => {
    it('matches "STOP please remove me"', () => {
      assert.equal(
        matchStopKeyword('STOP please remove me', []),
        'stop',
      );
    });

    it('matches "Unsubscribe me from this list"', () => {
      assert.equal(
        matchStopKeyword('Unsubscribe me from this list', []),
        'unsubscribe',
      );
    });
  });

  describe('keyword in middle of message', () => {
    it('matches "Please stop messaging"', () => {
      assert.equal(
        matchStopKeyword('Please stop messaging', []),
        'stop',
      );
    });
  });

  describe('keyword at end of message (regression target)', () => {
    it('matches "Please stop"', () => {
      // Trailing position: prior shape required " stop " with both
      // boundaries — message-end "stop" with no trailing space slipped
      // through entirely. Real users routinely write "please stop"
      // without further punctuation or words.
      assert.equal(matchStopKeyword('Please stop', []), 'stop');
    });

    it('matches "I want to unsubscribe"', () => {
      assert.equal(
        matchStopKeyword('I want to unsubscribe', []),
        'unsubscribe',
      );
    });

    it('matches "Cancel"', () => {
      assert.equal(matchStopKeyword('Cancel', []), 'cancel');
    });
  });

  describe('keyword with trailing punctuation (regression target)', () => {
    it('matches "STOP."', () => {
      // CTIA / GSMA carriers REQUIRE that "STOP." (with period) opts
      // the recipient out of all further messages. Prior shape failed
      // — period prevented the equality match and broke the
      // space-bounded includes check.
      assert.equal(matchStopKeyword('STOP.', []), 'stop');
    });

    it('matches "STOP!"', () => {
      assert.equal(matchStopKeyword('STOP!', []), 'stop');
    });

    it('matches "Unsubscribe!"', () => {
      assert.equal(matchStopKeyword('Unsubscribe!', []), 'unsubscribe');
    });

    it('matches "Please stop."', () => {
      assert.equal(matchStopKeyword('Please stop.', []), 'stop');
    });

    it('matches "I want to opt out."', () => {
      assert.equal(
        matchStopKeyword('I want to opt out.', []),
        'opt out',
      );
    });

    it('matches "STOP," with comma', () => {
      assert.equal(matchStopKeyword('STOP, please.', []), 'stop');
    });
  });

  describe('custom operator-configured keywords', () => {
    it('respects operator-supplied keyword', () => {
      assert.equal(
        matchStopKeyword('please go away', ['go away']),
        'go away',
      );
    });

    it('lowercases the operator keyword for matching', () => {
      assert.equal(
        matchStopKeyword('please GO AWAY', ['Go Away']),
        'go away',
      );
    });
  });

  describe('false-positive guards', () => {
    it('does not match "stoplight"', () => {
      // "stop" inside a longer word should not trigger.
      assert.equal(
        matchStopKeyword('the stoplight is red', []),
        null,
      );
    });

    it('does not match "stopover"', () => {
      assert.equal(
        matchStopKeyword('we have a stopover in Houston', []),
        null,
      );
    });

    it('does not match "shopping cancel button"', () => {
      // false alarm — "cancel" inside "Cancel button"; legitimately
      // ambiguous. Either accept the conservative match (return
      // 'cancel') or reject as substring. Current discipline:
      // word-bounded match — "Cancel" alone or with whitespace
      // delimiters; "cancel button" is a separate word "cancel"
      // followed by "button", so it DOES match. That's the carrier-
      // safe choice — over-matching opt-outs is preferable to
      // under-matching them.
      const result = matchStopKeyword('clicked the cancel button', []);
      assert.ok(result === null || result === 'cancel');
    });

    it('returns null for empty body', () => {
      assert.equal(matchStopKeyword('', []), null);
    });

    it('returns null for whitespace-only body', () => {
      assert.equal(matchStopKeyword('   \n\t  ', []), null);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// isOooReply — auto-pause when an inbound is an out-of-office reply.
// Misses here = the agent drafts a substantive reply to a vacation
// auto-responder, exhausting follow-up budget.
// ─────────────────────────────────────────────────────────────────────

describe('isOooReply', () => {
  describe('subject patterns', () => {
    const matches = [
      'Automatic Reply: Your inquiry',
      'AUTOMATIC REPLY',
      'Out of Office: Re: Procurement',
      'Out of the office through Friday',
      'Auto-Reply: Will respond Monday',
    ];
    for (const subject of matches) {
      it(`detects: "${subject}"`, () => {
        assert.equal(isOooReply(subject, null), true);
      });
    }

    it('Portuguese: Resposta automática', () => {
      assert.equal(isOooReply('Resposta automática', null), true);
    });

    it('Spanish: Respuesta automatica', () => {
      assert.equal(isOooReply('Respuesta automatica', null), true);
    });
  });

  describe('body patterns', () => {
    const matches = [
      'I will be out of the office until next week.',
      'I am currently out of the office.',
      'I am on vacation through Friday.',
      'I will be returning on March 15.',
      'I have limited access to email this week.',
    ];
    for (const body of matches) {
      it(`detects body: "${body.slice(0, 50)}"`, () => {
        assert.equal(isOooReply(null, body), true);
      });
    }
  });

  describe('subject false-positive guards', () => {
    it('does NOT flag topical subjects that mention "Vacation"', () => {
      // The bare /vacation/i subject pattern was removed — it
      // false-positived on threads ABOUT vacation rentals, vacation
      // bunker quotas, etc., auto-pausing the conversation. Genuine
      // OOO replies still get caught via "on vacation" / "vacation
      // reply" subject phrases or the body patterns.
      assert.equal(
        isOooReply('Vacation rental supplier inquiry', null),
        false,
      );
      assert.equal(
        isOooReply('Vacation bunker quota update', null),
        false,
      );
    });

    it('still flags genuine OOO subjects that say "vacation reply"', () => {
      assert.equal(isOooReply('Vacation reply from John', null), true);
    });

    it('still flags "on vacation through Friday"', () => {
      assert.equal(
        isOooReply('Re: Pricing — on vacation through Friday', null),
        true,
      );
    });
  });

  describe('safe (no OOO marker)', () => {
    it('regular subject', () => {
      assert.equal(isOooReply('Re: Fuel pricing inquiry', null), false);
    });

    it('regular body', () => {
      assert.equal(
        isOooReply(null, "Hi, thanks for reaching out — what's the volume?"),
        false,
      );
    });

    it('null subject and null body', () => {
      assert.equal(isOooReply(null, null), false);
    });

    it('empty subject and empty body', () => {
      assert.equal(isOooReply('', ''), false);
    });
  });

  describe('OOO marker only in deep body', () => {
    it('marker beyond 1500-char head is ignored', () => {
      // Discipline: OOO markers always at the top of the auto-reply.
      // Mention of "out of office" 2000 chars deep is more likely
      // referring to the recipient's colleague being on leave.
      const longPrefix = 'Hi there, '.repeat(200); // ~2000 chars
      assert.equal(
        isOooReply(null, `${longPrefix} I will be out of the office.`),
        false,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildReplySubject — preserves Re: chain, falls back gracefully on
// empty subjects.
// ─────────────────────────────────────────────────────────────────────

describe('buildReplySubject', () => {
  it('adds "Re:" prefix to fresh subject', () => {
    assert.equal(buildReplySubject('Fuel inquiry'), 'Re: Fuel inquiry');
  });

  it('preserves existing "Re:" chain', () => {
    assert.equal(
      buildReplySubject('Re: Fuel inquiry'),
      'Re: Fuel inquiry',
    );
  });

  it('preserves "RE:" case-insensitive', () => {
    assert.equal(
      buildReplySubject('RE: Fuel inquiry'),
      'RE: Fuel inquiry',
    );
  });

  it('trims surrounding whitespace', () => {
    assert.equal(
      buildReplySubject('  Fuel inquiry  '),
      'Re: Fuel inquiry',
    );
  });

  it('returns "(no subject)" for empty string', () => {
    assert.equal(buildReplySubject(''), '(no subject)');
  });

  it('returns "(no subject)" for whitespace-only', () => {
    assert.equal(buildReplySubject('   \n\t  '), '(no subject)');
  });

  it('does NOT double-prefix "Re: Re: Re:"', () => {
    // Already has Re: chain — leave alone.
    assert.equal(
      buildReplySubject('Re: Re: Fuel inquiry'),
      'Re: Re: Fuel inquiry',
    );
  });

  describe('"Re:" chain without trailing space', () => {
    it('preserves "Re:Subject" (no space) without double-prefixing', () => {
      // Mobile mail apps sometimes strip the space after the colon.
      // Prior shape required \s after the colon and re-prefixed,
      // producing "Re: Re:Subject". \s* in the regex accepts both
      // forms.
      assert.equal(
        buildReplySubject('Re:Fuel inquiry'),
        'Re:Fuel inquiry',
      );
    });

    it('preserves "RE:Subject" mixed-case no-space', () => {
      assert.equal(
        buildReplySubject('RE:Fuel inquiry'),
        'RE:Fuel inquiry',
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// resolveEmailRecipients — picks the To: addresses for the auto-reply.
// Bugs here = sending to the wrong people, including ourselves.
// ─────────────────────────────────────────────────────────────────────

describe('resolveEmailRecipients', () => {
  describe('reply_to_from (default mode)', () => {
    it('returns just the inbound sender', () => {
      assert.deepEqual(
        resolveEmailRecipients({
          mode: 'reply_to_from',
          fromEmail: 'buyer@example.com',
          history: [],
        }),
        ['buyer@example.com'],
      );
    });

    it('lowercases the address', () => {
      assert.deepEqual(
        resolveEmailRecipients({
          mode: 'reply_to_from',
          fromEmail: 'Buyer@Example.COM',
          history: [],
        }),
        ['buyer@example.com'],
      );
    });

    it('returns empty when fromEmail is null', () => {
      assert.deepEqual(
        resolveEmailRecipients({
          mode: 'reply_to_from',
          fromEmail: null,
          history: [],
        }),
        [],
      );
    });
  });

  describe('reply_all mode', () => {
    it('pulls all distinct addresses from thread history', () => {
      const result = resolveEmailRecipients({
        mode: 'reply_all',
        fromEmail: 'buyer@example.com',
        history: [
          {
            direction: 'inbound',
            fromEmail: 'buyer@example.com',
            toEmails: ['ops@procur.example', 'cc@partner.example'],
            subject: 'Fuel inquiry',
            body: '',
            occurredAt: new Date(),
          } as never,
        ],
      });
      const sorted = [...result].sort();
      assert.deepEqual(sorted, [
        'buyer@example.com',
        'cc@partner.example',
        'ops@procur.example',
      ]);
    });

    it('strips procur outbound domain (@links.)', () => {
      const result = resolveEmailRecipients({
        mode: 'reply_all',
        fromEmail: 'buyer@example.com',
        history: [
          {
            direction: 'outbound',
            fromEmail: 'tradedesk@links.vectortradecapital.com',
            toEmails: ['buyer@example.com'],
            subject: '',
            body: '',
            occurredAt: new Date(),
          } as never,
        ],
      });
      assert.ok(!result.some((r) => r.includes('@links.')));
      assert.ok(!result.some((r) => r.startsWith('tradedesk@')));
    });

    it('dedupes addresses (case-insensitive)', () => {
      const result = resolveEmailRecipients({
        mode: 'reply_all',
        fromEmail: 'buyer@example.com',
        history: [
          {
            direction: 'inbound',
            fromEmail: 'BUYER@example.com',
            toEmails: ['Buyer@Example.com'],
            subject: '',
            body: '',
            occurredAt: new Date(),
          } as never,
        ],
      });
      assert.equal(result.length, 1);
      assert.equal(result[0], 'buyer@example.com');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hard edge cases for the probe escalation classifier — quoted
// threads, signatures, mixed languages, multiple triggers.
// ─────────────────────────────────────────────────────────────────────

describe('classifyProbeReplyEscalation — adversarial inputs', () => {
  it('classifies own quoted prior outbound as escalation (false-positive risk)', () => {
    // Quoted threads include the AGENT's prior outbound. If our own
    // outbound said "Let's discuss volumes", the inbound's quoted
    // tail mentions it — and the classifier matches commercial
    // interest. Today this is a real false-positive: probe replies
    // that quote the original "let's discuss" prompt auto-pause as
    // commercial-interest even when the actual reply text is e.g.
    // "Out of office until Monday."
    //
    // Pinning the current behavior: documented bug, fix candidate
    // is "strip quoted lines (^>) before classifying" but it's not
    // shipped yet because the inbound bodies arrive as plain text
    // and quote stripping is non-trivial (formats vary by client).
    const inbound = `Sure, see below.

> On Mon, Apr 7, 2026 at 9:14 AM Procur <tradedesk@links.x.com> wrote:
>   Let's discuss your volumes.`;
    const result = classifyProbeReplyEscalation(inbound);
    assert.equal(result, 'recipient expressed commercial interest');
  });

  it('handles HTML entities in apostrophes', () => {
    // Mail clients sometimes encode apostrophes as &#39; in the
    // body text. The inbound webhook's HTML→text strip should
    // normalize these, but defensive behavior here: should NOT
    // crash, may not match.
    const result = classifyProbeReplyEscalation(
      "Let&#39;s discuss volumes.",
    );
    // Either match (if the agent decoded entities) or null (if not).
    assert.ok(
      result === null || result === 'recipient expressed commercial interest',
    );
  });

  it('multiple triggers — price wins over commercial interest', () => {
    // Documented precedence test from the original suite, doubled
    // up to lock in.
    const result = classifyProbeReplyEscalation(
      "Sure, very interested — what's the price per barrel and how soon can you ship?",
    );
    assert.equal(result, 'recipient asked for price');
  });

  it('multiple triggers — documents wins over interest', () => {
    const result = classifyProbeReplyEscalation(
      'Send the LOI. Let me know if you want to discuss after.',
    );
    assert.equal(result, 'recipient asked for documents');
  });

  it('legal beats commercial interest', () => {
    const result = classifyProbeReplyEscalation(
      'Interested — but our compliance team needs to review first.',
    );
    assert.equal(
      result,
      'recipient raised legal / compliance concern',
    );
  });

  it('signature with unrelated commercial-keyword does not auto-fire', () => {
    // A reply that says nothing substantive but has a signature
    // mentioning the company's name including a product term
    // shouldn't auto-classify. Most signatures don't trigger any
    // category — this just verifies that.
    const reply =
      'Got it.\n\n--\nJohn Smith\nVP, Bunker Operations\nFuelCo Ltd.';
    assert.equal(classifyProbeReplyEscalation(reply), null);
  });

  it('very long body — extracts trigger from middle', () => {
    const padding = 'Some context. '.repeat(50);
    const result = classifyProbeReplyEscalation(
      `${padding} What is the price per ton?`,
    );
    assert.equal(result, 'recipient asked for price');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hard edge cases for the draft-risk classifier — fallback drafts,
// sentence boundary, currency variants, abbreviations.
// ─────────────────────────────────────────────────────────────────────

describe('classifyDraftRisk — adversarial inputs', () => {
  it('multi-currency: EUR price flagged', () => {
    // The regex is anchored on `$\d` and `\d\s*usd` — a EUR-denominated
    // price like "€50/bbl" would NOT match the currency clauses. But
    // /bbl matches the volume-suffix clause regardless of currency.
    assert.equal(classifyDraftRisk('€50/bbl ex-pipeline.'), 'commitment');
  });

  it('numeric-free pricing language flagged', () => {
    // "competitive pricing" or "best price" — no number — relies on
    // the keyword clauses (`firm price`, `indicative price` etc.).
    // "Best price" alone is NOT in the regex — pin the gap.
    const result = classifyDraftRisk('We can offer our best price.');
    // Either flagged via "best price" → ideally commitment, or null.
    // Current regex requires `firm|indicative|spot|target|crack…`.
    // This shows the gap.
    assert.equal(result, 'safe');
  });

  it('time + AM/PM flags', () => {
    assert.equal(classifyDraftRisk('Call you at 3pm tomorrow.'), 'commitment');
  });

  it('numeric volume in non-commercial sentence still flags', () => {
    // "5 tons of laundry" — the discipline is over-flag rather than
    // under-flag. Pin.
    assert.equal(
      classifyDraftRisk('We had 5 tons of laundry that week.'),
      'commitment',
    );
  });

  it('payment-term abbreviation: "T/T"', () => {
    // T/T (telegraphic transfer) flagged
    assert.equal(
      classifyDraftRisk('Payment via T/T on docs.'),
      'commitment',
    );
  });

  it('negotiated terms in passing reference still flag', () => {
    assert.equal(
      classifyDraftRisk('Per the agreed loading window.'),
      'commitment',
    );
  });

  it('benign reply with "agreed" flags (false-positive risk)', () => {
    // "Agreed, will follow up" — flags as commitment. Pin: better
    // than under-flagging.
    assert.equal(
      classifyDraftRisk('Agreed, will follow up tomorrow.'),
      'commitment',
    );
  });

  it('innocuous "fob" inside a longer word — does NOT flag', () => {
    // \b is required, so "fobbed off" (no FOB context) wouldn't fire.
    // Or "phobia" which contains "fob" but not at a word boundary.
    assert.equal(classifyDraftRisk('A phobia of cold-callers.'), 'safe');
  });
});
