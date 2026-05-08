import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFormEndpoints } from './extract-form-endpoints';

/**
 * Regression coverage for multilingual field-role inference. The
 * earlier shape used English-only regex, so non-English contact forms
 * silently dropped out of autopilot eligibility (message_field never
 * resolved → pickAutopilotEligibleEndpoint returned null). These
 * tests pin the keyword coverage so adding a market doesn't quietly
 * lose another locale.
 */

function buildPage(formInner: string, lang = 'en'): string {
  return `<!doctype html><html lang="${lang}"><body><form method="post" action="/contact">${formInner}</form></body></html>`;
}

describe('extractFormEndpoints — English baseline', () => {
  it('resolves canonical English contact form', () => {
    const html = buildPage(`
      <input type="text" name="name" />
      <input type="email" name="email" />
      <input type="text" name="subject" />
      <textarea name="message"></textarea>
    `);
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://acme.example/contact',
    });
    assert.ok(endpoint, 'endpoint detected');
    assert.equal(endpoint.nameField, 'name');
    assert.equal(endpoint.emailField, 'email');
    assert.equal(endpoint.subjectField, 'subject');
    assert.equal(endpoint.messageField, 'message');
    assert.equal(endpoint.detectedCaptchaKind, null);
    assert.equal(endpoint.submitMethod, 'http_post');
  });
});

describe('extractFormEndpoints — multilingual labels', () => {
  it('resolves a Japanese contact form via labels', () => {
    // Japanese form: opaque field names, role signal lives in <label>.
    const html = buildPage(
      `
      <label for="f1">お名前</label>
      <input type="text" id="f1" name="field_name_jp" />
      <label for="f2">メールアドレス</label>
      <input type="email" id="f2" name="field_email_jp" />
      <label for="f3">件名</label>
      <input type="text" id="f3" name="field_subject_jp" />
      <label for="f4">お問い合わせ内容</label>
      <textarea id="f4" name="field_message_jp"></textarea>
    `,
      'ja',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.co.jp/contact',
    });
    assert.ok(endpoint, 'endpoint detected for Japanese form');
    assert.equal(endpoint.language, 'ja');
    assert.equal(endpoint.nameField, 'field_name_jp');
    assert.equal(endpoint.emailField, 'field_email_jp');
    assert.equal(endpoint.subjectField, 'field_subject_jp');
    assert.equal(endpoint.messageField, 'field_message_jp');
  });

  it('resolves a Korean contact form via labels', () => {
    const html = buildPage(
      `
      <label for="a">이름</label>
      <input type="text" id="a" name="kr_name" />
      <label for="b">이메일</label>
      <input type="email" id="b" name="kr_email" />
      <label for="c">제목</label>
      <input type="text" id="c" name="kr_subject" />
      <label for="d">문의 내용</label>
      <textarea id="d" name="kr_message"></textarea>
    `,
      'ko',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.co.kr/contact',
    });
    assert.ok(endpoint, 'endpoint detected for Korean form');
    assert.equal(endpoint.messageField, 'kr_message');
    assert.equal(endpoint.nameField, 'kr_name');
    assert.equal(endpoint.emailField, 'kr_email');
  });

  it('resolves a simplified-Chinese contact form via labels', () => {
    const html = buildPage(
      `
      <label for="a">姓名</label>
      <input type="text" id="a" name="cn_name" />
      <label for="b">邮箱</label>
      <input type="email" id="b" name="cn_email" />
      <label for="c">公司</label>
      <input type="text" id="c" name="cn_company" />
      <label for="d">留言</label>
      <textarea id="d" name="cn_message"></textarea>
    `,
      'zh',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.cn/contact',
    });
    assert.ok(endpoint, 'endpoint detected for Chinese form');
    assert.equal(endpoint.messageField, 'cn_message');
    assert.equal(endpoint.companyField, 'cn_company');
  });

  it('resolves a Spanish contact form via labels', () => {
    const html = buildPage(
      `
      <label for="a">Nombre</label>
      <input type="text" id="a" name="es_name" />
      <label for="b">Correo electrónico</label>
      <input type="email" id="b" name="es_email" />
      <label for="c">Empresa</label>
      <input type="text" id="c" name="es_company" />
      <label for="d">Mensaje</label>
      <textarea id="d" name="es_message"></textarea>
    `,
      'es',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.es/contacto',
    });
    assert.ok(endpoint, 'endpoint detected for Spanish form');
    assert.equal(endpoint.messageField, 'es_message');
    assert.equal(endpoint.nameField, 'es_name');
    assert.equal(endpoint.companyField, 'es_company');
  });

  it('resolves a French contact form via labels', () => {
    const html = buildPage(
      `
      <label for="a">Nom</label>
      <input type="text" id="a" name="fr_name" />
      <label for="b">Courriel</label>
      <input type="email" id="b" name="fr_email" />
      <label for="c">Société</label>
      <input type="text" id="c" name="fr_company" />
      <label for="d">Message</label>
      <textarea id="d" name="fr_message"></textarea>
    `,
      'fr',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.fr/contact',
    });
    assert.ok(endpoint, 'endpoint detected for French form');
    assert.equal(endpoint.companyField, 'fr_company');
    assert.equal(endpoint.messageField, 'fr_message');
  });

  it('resolves a German contact form via labels', () => {
    const html = buildPage(
      `
      <label for="a">Name</label>
      <input type="text" id="a" name="de_name" />
      <label for="b">E-Mail</label>
      <input type="email" id="b" name="de_email" />
      <label for="c">Firma</label>
      <input type="text" id="c" name="de_company" />
      <label for="d">Nachricht</label>
      <textarea id="d" name="de_message"></textarea>
    `,
      'de',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.de/kontakt',
    });
    assert.ok(endpoint, 'endpoint detected for German form');
    assert.equal(endpoint.companyField, 'de_company');
    assert.equal(endpoint.messageField, 'de_message');
  });
});

describe('extractFormEndpoints — autocomplete attribute precedence', () => {
  it('picks autocomplete-tagged fields over labels', () => {
    // Autocomplete is HTML5-spec English regardless of UI language.
    // Should be the strongest signal — beats CJK label matches.
    const html = buildPage(
      `
      <input type="text" name="opaque1" autocomplete="name" />
      <input type="text" name="opaque2" autocomplete="email" />
      <input type="text" name="opaque3" autocomplete="organization" />
      <input type="text" name="opaque4" autocomplete="tel" />
      <textarea name="opaque5"></textarea>
    `,
      'ja',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.co.jp/inquiry',
    });
    assert.ok(endpoint, 'endpoint detected via autocomplete');
    assert.equal(endpoint.nameField, 'opaque1');
    assert.equal(endpoint.emailField, 'opaque2');
    assert.equal(endpoint.companyField, 'opaque3');
    assert.equal(endpoint.phoneField, 'opaque4');
    assert.equal(endpoint.messageField, 'opaque5');
  });
});

describe('extractFormEndpoints — captcha detection still fires on multilingual forms', () => {
  it('flags reCAPTCHA on a Japanese form', () => {
    const html = buildPage(
      `
      <label>お名前<input type="text" name="name" /></label>
      <label>メール<input type="email" name="email" /></label>
      <label>お問い合わせ<textarea name="message"></textarea></label>
      <div class="g-recaptcha" data-sitekey="abc"></div>
      <button type="submit">送信</button>
    `,
      'ja',
    );
    const [endpoint] = extractFormEndpoints({
      html,
      pageUrl: 'https://example.co.jp/contact',
    });
    assert.ok(endpoint);
    assert.equal(endpoint.detectedCaptchaKind, 'recaptcha_v2');
  });
});
