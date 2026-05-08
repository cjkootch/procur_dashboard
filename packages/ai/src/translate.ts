import { getClient, MODELS } from './client';

/**
 * Inbound-message translation helper used by the resend-inbound and
 * twilio webhooks. One Haiku call: detect language + translate to
 * English when the source isn't already English.
 *
 * Output shape is intentionally compact so callers can dump it into
 * `messages.metadata` / `touchpoints.metadata` without restructuring.
 *
 * Discipline:
 *   - never throws — translation must NEVER block persistence of the
 *     inbound itself. On any failure, returns null and the caller
 *     just stores the original.
 *   - skips the LLM call entirely when the body is empty / under 6
 *     characters of letters. That avoids wasting tokens on ack
 *     messages like "ok", "yes", numbers, emojis.
 *   - clamps very long inputs at 4000 chars so a giant email body
 *     doesn't blow up Haiku's max_tokens budget. Truncation is
 *     marker-prefixed so the operator knows.
 */

export interface TranslatedInbound {
  /** ISO 639-1 (or 639-3 fallback) when Haiku is sure; lowercase. */
  detectedLanguageCode: string;
  /** Human-readable language name for the chip ("Spanish", "Portuguese"). */
  detectedLanguageName: string;
  /** Confidence in [0,1] reported by the model. Soft signal — clients
   *  can de-emphasize the "Translated from …" tag when this is low. */
  confidence: number;
  /** English translation of the body. Null when source was already
   *  English (detectedLanguageCode === 'en'). */
  translationEn: string | null;
  /** Optional English translation of the subject (when the input
   *  included a subject — emails). Null for sms/whatsapp where there
   *  is no subject, and null when source was already English. */
  subjectTranslationEn?: string | null;
}

const MAX_INPUT_CHARS = 4_000;
const MIN_LETTERS_TO_DETECT = 6;

function letterCount(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) n += 1;
  }
  return n;
}

function clamp(s: string, max = MAX_INPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…[truncated for translation]';
}

/**
 * Detect language and translate to English. Returns null when:
 *   - input is empty / has fewer than 6 letters
 *   - the LLM call fails for any reason
 *
 * Callers should treat null as "no translation, render the original."
 * The webhook never blocks on translation errors.
 */
export async function translateInboundMessage(input: {
  body: string;
  subject?: string | null;
}): Promise<TranslatedInbound | null> {
  const body = (input.body ?? '').trim();
  if (!body || letterCount(body) < MIN_LETTERS_TO_DETECT) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const subject = (input.subject ?? '').trim();
  const subjectLine = subject
    ? `Subject (translate this too if non-English):\n${clamp(subject, 500)}\n\n`
    : '';

  const system = `You are a language-detection + translation utility for a
trading-desk inbox. Receive an inbound message body (and optional subject).
Return a JSON object with:

  language_code:    ISO 639-1 lowercase code when known (en, es, pt, fr,
                    zh, ja, ar, ru, …). Use ISO 639-3 only when 639-1
                    doesn't apply.
  language_name:    Human-readable English name of the language.
  confidence:       Float in [0,1] — your confidence in the detection.
  translation:      English translation of the body. When the source
                    is already English, set this to null.
  subject_translation: English translation of the subject when one was
                       provided AND the source isn't English. Otherwise
                       null. Omit the key entirely if no subject was
                       provided.

Guidelines:
- Translation should be faithful to meaning, not literal. Preserve
  trader / commercial register; don't make it more formal or more
  casual than the original.
- Strip email-client signature blocks ("Sent from my iPhone", quoted
  reply chains starting with "On <date>, X wrote:") from the
  translation — but only from the translation. The original is stored
  verbatim.
- Keep proper nouns (company names, vessel names, port names) in
  their original form.
- Never invent content. If the source is partial or cut off, translate
  exactly what you have.

Return ONLY the JSON object — no markdown fences, no commentary.`;

  const user = `${subjectLine}Body:
${clamp(body)}`;

  try {
    const client = getClient();
    const resp = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text.trim() : '';
    if (!text) return null;
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned) as {
      language_code?: unknown;
      language_name?: unknown;
      confidence?: unknown;
      translation?: unknown;
      subject_translation?: unknown;
    };
    const code = String(parsed.language_code ?? '').toLowerCase().slice(0, 8);
    const name = String(parsed.language_name ?? '').slice(0, 40);
    const conf =
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    if (!code || !name) return null;
    const translation =
      code === 'en'
        ? null
        : typeof parsed.translation === 'string' && parsed.translation.trim()
          ? parsed.translation.trim()
          : null;
    const subjectTranslation =
      code === 'en' || !subject
        ? null
        : typeof parsed.subject_translation === 'string' &&
            parsed.subject_translation.trim()
          ? parsed.subject_translation.trim()
          : null;
    const out: TranslatedInbound = {
      detectedLanguageCode: code,
      detectedLanguageName: name,
      confidence: conf,
      translationEn: translation,
    };
    if (subject) out.subjectTranslationEn = subjectTranslation;
    return out;
  } catch (err) {
    console.error('[translate] inbound translation failed', err);
    return null;
  }
}
