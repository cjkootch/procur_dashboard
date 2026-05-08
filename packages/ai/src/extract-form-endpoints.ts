import * as cheerio from 'cheerio';

/**
 * Form-detection pass for the entity-website crawler. Runs against
 * the raw HTML of any crawled page and returns discovered contact-
 * form endpoints with field maps + anti-bot detection.
 *
 * Submission discipline (load-bearing): this module's job is to
 * SURFACE the captcha kind, not to bypass it. Detection is
 * conservative — when in doubt, classify as captcha-protected
 * (`detected_captcha_kind = 'unknown'`) and let the autopilot skip
 * rather than risk a CAPTCHA-protected POST. The downstream
 * executor refuses to submit any endpoint with a non-null
 * `detected_captcha_kind` regardless of value.
 */

export interface DetectedFormField {
  name: string;
  type: string;
  label?: string;
  required: boolean;
  options?: string[];
  autocomplete?: string;
}

export interface DetectedFormEndpoint {
  url: string;
  submitMethod: 'http_post' | 'js_only' | 'unknown';
  detectedCaptchaKind:
    | null
    | 'recaptcha_v2'
    | 'recaptcha_v3'
    | 'hcaptcha'
    | 'turnstile'
    | 'honeypot'
    | 'cloudflare'
    | 'unknown';
  fields: DetectedFormField[];
  /** Field-role inferences from name / label / autocomplete. Null
   *  when discovery couldn't identify a field for the role. */
  nameField: string | null;
  emailField: string | null;
  subjectField: string | null;
  messageField: string | null;
  companyField: string | null;
  phoneField: string | null;
  language: string | null;
}

/**
 * Walks the HTML and returns 0+ detected form endpoints. A page can
 * have multiple <form> elements (e.g., separate newsletter signup +
 * contact form on the same page); each becomes its own endpoint
 * row keyed on the resolved action URL.
 *
 * Excludes forms that are clearly NOT contact-form-shaped:
 *   - Search forms (single text input, role="search", or input
 *     type="search")
 *   - Login forms (password input present)
 *   - Cart / checkout forms (action contains 'cart' / 'checkout')
 *   - Newsletter-only forms (single email field, no message field)
 */
export function extractFormEndpoints(input: {
  html: string;
  pageUrl: string;
}): DetectedFormEndpoint[] {
  const $ = cheerio.load(input.html);
  const pageBaseUrl = input.pageUrl;

  // Page-level CAPTCHA / Cloudflare detection. If the page itself is
  // sitting behind a CF challenge, ANY form on it is unsubmittable.
  const pageBodyText = $('body').text().slice(0, 5000);
  const pageHasCloudflareChallenge =
    /cloudflare|just a moment|checking your browser|cf-(chl|challenge)/i.test(
      pageBodyText,
    ) ||
    $('script[src*="cloudflare.com/cdn-cgi/challenge"]').length > 0 ||
    $('[id*="cf-challenge"]').length > 0;

  const language = $('html').attr('lang') ?? null;

  const detected: DetectedFormEndpoint[] = [];
  $('form').each((_, formEl) => {
    const $form = $(formEl);

    // Skip search / login / cart / nav forms
    const role = ($form.attr('role') ?? '').toLowerCase();
    if (role === 'search') return;
    if ($form.find('input[type="password"]').length > 0) return;
    if ($form.find('input[type="search"]').length > 0) return;
    const rawAction = ($form.attr('action') ?? '').toLowerCase();
    if (
      /\b(cart|checkout|signin|sign-in|login|log-in|payment)\b/.test(
        rawAction,
      )
    ) {
      return;
    }

    // Collect fields. Inlined here to avoid threading cheerio element
    // types across helpers — cheerio's exported types in v1.2 don't
    // include the AnyNode/Element shapes directly, and pulling
    // domhandler in as a typing-only dep adds noise.
    const fields: DetectedFormField[] = [];
    $form.find('input, textarea, select').each((_, el) => {
      const $el = $(el);
      // tagName is on the cheerio element wrapper; `prop('tagName')`
      // returns it cross-version-safely.
      const tagName = String($el.prop('tagName') ?? '').toLowerCase();
      const type =
        tagName === 'textarea'
          ? 'textarea'
          : tagName === 'select'
            ? 'select'
            : ($el.attr('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'reset' || type === 'button') return;
      const name = $el.attr('name');
      if (!name) return;
      const required = $el.attr('required') != null;
      const autocomplete = $el.attr('autocomplete') ?? undefined;

      // Resolve label.
      let label: string | undefined;
      const id = $el.attr('id');
      if (id) {
        const $label = $(`label[for="${id.replace(/(["\\])/g, '\\$1')}"]`);
        if ($label.length > 0) {
          const text = $label.first().text().trim();
          if (text) label = text.slice(0, 200);
        }
      }
      if (!label) {
        const $parentLabel = $el.closest('label');
        if ($parentLabel.length > 0) {
          const text = $parentLabel.first().text().trim();
          if (text) label = text.slice(0, 200);
        }
      }
      if (!label) {
        const ariaLabel = $el.attr('aria-label');
        if (ariaLabel) label = ariaLabel.trim().slice(0, 200);
      }
      if (!label) {
        const placeholder = $el.attr('placeholder');
        if (placeholder) label = placeholder.trim().slice(0, 200);
      }

      const options =
        tagName === 'select'
          ? $el
              .find('option')
              .map((_i, o) => $(o).attr('value') ?? $(o).text())
              .get()
              .filter(
                (v): v is string => typeof v === 'string' && v.length > 0,
              )
          : undefined;

      fields.push({
        name,
        type,
        ...(label ? { label } : {}),
        required,
        ...(options && options.length > 0 ? { options } : {}),
        ...(autocomplete ? { autocomplete } : {}),
      });
    });
    if (fields.length === 0) return;

    // Newsletter-only forms have ≤2 fields, none of which are
    // textarea-shaped. Treat as not-a-contact-form.
    //
    // Multilingual: textarea-type alone is the universal signal
    // (HTML element type works regardless of UI language). Beyond
    // that, check English `name=` patterns AND multilingual label
    // keywords so a Japanese form whose textarea has name="message"
    // OR label="お問い合わせ" both qualify.
    const hasMessageField = fields.some(
      (f) =>
        f.type === 'textarea' ||
        /message|comment|inquiry|enquiry|details|notes/i.test(f.name) ||
        (f.label != null &&
          labelMatchesAny(
            f.label.toLowerCase(),
            MULTILINGUAL_LABEL_KEYWORDS.message,
          )),
    );
    if (!hasMessageField) return;

    const action = resolveActionUrl(
      $form.attr('action') ?? '',
      pageBaseUrl,
    );
    const method = ($form.attr('method') ?? 'get').toLowerCase();
    const enctype = ($form.attr('enctype') ?? '')
      .toLowerCase()
      .split(';')[0]
      ?.trim();

    let submitMethod: DetectedFormEndpoint['submitMethod'] = 'unknown';
    if (method === 'post') {
      // multipart/form-data forms accept our urlencoded POST but
      // ignore the body — we'd think we submitted a contact request
      // and the form-owner would never see anything. Classify as
      // unknown so the executor refuses; can be lifted later by
      // teaching the executor to format multipart bodies.
      // application/x-www-form-urlencoded (default when enctype is
      // missing or set to that) is what the executor handles today;
      // text/plain is rare but acceptable since the body shape is
      // similar enough that POST semantics still work.
      if (
        !enctype ||
        enctype === 'application/x-www-form-urlencoded' ||
        enctype === 'text/plain'
      ) {
        submitMethod = 'http_post';
      } else {
        submitMethod = 'unknown';
      }
    } else if (
      // GET-method "forms" that are actually JS-driven send the data
      // via a JS handler instead of the action; we can't reliably
      // submit those without a real browser.
      $form.find('button[type="submit"]').length === 0 &&
      $form.find('input[type="submit"]').length === 0
    ) {
      submitMethod = 'js_only';
    }

    // CAPTCHA / honeypot detection within the form.
    let captcha: DetectedFormEndpoint['detectedCaptchaKind'] =
      pageHasCloudflareChallenge ? 'cloudflare' : null;
    if (!captcha) {
      const formHtml = $.html($form);
      if (
        /\brecaptcha\/api\.js/i.test(formHtml) ||
        $form.find('.g-recaptcha').length > 0 ||
        $form.find('iframe[src*="recaptcha"]').length > 0
      ) {
        captcha =
          /grecaptcha\.execute|data-size=["']invisible["']/i.test(formHtml) &&
          $form.find('.g-recaptcha').length === 0
            ? 'recaptcha_v3'
            : 'recaptcha_v2';
      } else if (
        /hcaptcha\.com/i.test(formHtml) ||
        $form.find('.h-captcha').length > 0 ||
        $form.find('iframe[src*="hcaptcha.com"]').length > 0
      ) {
        captcha = 'hcaptcha';
      } else if (
        /challenges\.cloudflare\.com\/turnstile/i.test(formHtml) ||
        $form.find('.cf-turnstile').length > 0 ||
        $form.find('iframe[src*="turnstile"]').length > 0
      ) {
        captcha = 'turnstile';
      } else if (detectHoneypot($, $form)) {
        captcha = 'honeypot';
      }
    }

    detected.push({
      url: action || pageBaseUrl,
      submitMethod,
      detectedCaptchaKind: captcha,
      fields,
      ...inferFieldRoles(fields),
      language,
    });
  });

  return detected;
}

// `$form` is typed as `cheerio.Cheerio<Element>` at the call site
// (cheerio's CheerioAPI returns Element-typed wrappers from a tag
// selector), but the Element type comes from domhandler — a
// transitive dep we don't import directly. Using `any` for the
// narrow helper boundary keeps the public interface clean without
// taking on a typing dep.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectHoneypot($: cheerio.CheerioAPI, $form: any): boolean {
  const honeypotNames = [
    'website',
    'url',
    'homepage',
    'company_url',
    'email_confirm',
    'email_address',
    'comment_body',
    'phone_b',
  ];
  let hit = false;
  $form.find('input[type="hidden"]').each((_: number, el: unknown) => {
    const name = ($(el as never).attr('name') ?? '').toLowerCase();
    if (honeypotNames.includes(name)) hit = true;
  });
  if (hit) return true;
  $form.find('input').each((_: number, el: unknown) => {
    const $el = $(el as never);
    const style = ($el.attr('style') ?? '').toLowerCase();
    const className = ($el.attr('class') ?? '').toLowerCase();
    if (
      /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/.test(
        style,
      )
    ) {
      hit = true;
    }
    if (/honeypot|hp-field|nobot|trap/.test(className)) hit = true;
  });
  return hit;
}

function resolveActionUrl(action: string, pageUrl: string): string {
  if (!action || action === '#' || action.startsWith('javascript:')) {
    return pageUrl;
  }
  try {
    return new URL(action, pageUrl).toString();
  } catch {
    return pageUrl;
  }
}

// English HTML `name=` attribute patterns. Devs conventionally use
// English names (`name="email"`) even on non-English forms, so these
// stay as the primary keyed-attribute match across all locales.
const NAME_PATTERNS = /^(name|fname|first_?name|full_?name|your_?name|contact_?name)$/i;
const EMAIL_PATTERNS = /^(email|e_?mail|email_?address|your_?email|contact_?email)$/i;
const SUBJECT_PATTERNS = /^(subject|topic|reason|inquiry_?subject)$/i;
const MESSAGE_PATTERNS = /^(message|comments?|inquiry|enquiry|details|body|description|notes)$/i;
const COMPANY_PATTERNS = /^(company|company_?name|organization|organisation|business|firm)$/i;
const PHONE_PATTERNS = /^(phone|tel|telephone|mobile|cell|contact_?phone)$/i;

/**
 * Multilingual label-text keywords for field-role inference. Substring-
 * match (label.includes(keyword)) — word-boundary regex doesn't work
 * uniformly across CJK / Arabic / Cyrillic, and form labels vary in
 * formatting (colons, asterisks for required, decorations) so loose
 * substring is more robust than strict matching.
 *
 * Coverage rationale: probes are experimental — operators may target
 * any market. The original English-only patterns silently dropped
 * Japanese / Korean / Chinese / Arabic / Cyrillic forms (the
 * message_field never resolved, so pickAutopilotEligibleEndpoint
 * filtered them out as ineligible). This list covers the major
 * business languages outside English. Casing: Latin entries are
 * lowercase (label is lowercased before matching); CJK / Arabic /
 * Cyrillic don't have case so casing is irrelevant.
 */
const MULTILINGUAL_LABEL_KEYWORDS = {
  name: [
    // English (already covered by regex above; included for completeness)
    'name', 'full name', 'your name', 'contact name',
    // Japanese
    'お名前', '名前', '氏名',
    // Korean
    '이름', '성함', '성명',
    // Chinese (simplified + traditional)
    '姓名', '名字', '稱呼', '称呼',
    // Arabic
    'الاسم', 'اسم',
    // Cyrillic (Russian)
    'имя', 'фио',
    // Spanish, Portuguese
    'nombre', 'nome',
    // French
    'nom', 'prénom', 'prenom',
    // German
    'vorname', 'nachname',
  ],
  email: [
    'email', 'e-mail', 'mail',
    'メール', 'メールアドレス', 'eメール',
    '이메일', '메일',
    '邮箱', '邮件', '电子邮件', '電郵', '郵件', '電子郵件',
    'البريد', 'إيميل',
    'почт', 'эл',
    'correo', 'courriel',
  ],
  subject: [
    'subject', 'topic',
    '件名', 'タイトル',
    '제목',
    '主题', '主題', '标题', '標題',
    'الموضوع',
    'тема',
    'asunto', 'assunto',
    'sujet', 'objet',
    'betreff',
  ],
  message: [
    'message', 'comment', 'inquiry', 'enquiry', 'notes',
    'お問い合わせ', '内容', 'メッセージ', 'ご相談', 'ご質問',
    '문의', '내용', '메시지',
    '留言', '咨询', '諮詢', '訊息', '信息',
    'الرسالة', 'التعليق', 'الاستفسار',
    'сообщение', 'комментарий', 'вопрос',
    'mensaje', 'mensagem', 'consulta', 'comentario',
    'message', 'commentaire', 'demande',
    'nachricht', 'anliegen',
  ],
  company: [
    'company', 'organization', 'organisation', 'business', 'firm',
    '会社名', '企業名', '会社', '御社名',
    '회사', '회사명', '기업',
    '公司', '公司名称', '公司名稱', '企业',
    'الشركة', 'المؤسسة',
    'компания', 'организация',
    'empresa', 'compañía', 'companhia',
    'société', 'societe', 'entreprise',
    'firma', 'unternehmen',
  ],
  phone: [
    'phone', 'telephone', 'mobile', 'tel', 'cell',
    '電話', '電話番号', 'tel',
    '전화', '연락처', '휴대폰',
    '电话', '手机', '聯絡方式', '联系方式',
    'الهاتف', 'الجوال', 'رقم',
    'телефон',
    'teléfono', 'móvil', 'telefone',
    'téléphone', 'telephone',
    'telefon',
  ],
} as const;

function labelMatchesAny(label: string, keywords: readonly string[]): boolean {
  // label is already lowercased by the caller. CJK / Arabic / Cyrillic
  // are case-invariant so toLowerCase is a no-op for them.
  //
  // Match strategy depends on keyword script:
  //   - ASCII-only keywords (English / Romance / German etc.) use
  //     word-boundary regex. Avoids false positives like
  //     `label="Email frequency"` matching keyword `email` on a
  //     newsletter-shaped field, OR Korean `이메일` overlapping with
  //     English `mail` substring.
  //   - Non-ASCII keywords (CJK / Arabic / Cyrillic) use substring
  //     because those scripts don't have whitespace word boundaries
  //     and \b is meaningless.
  for (const kw of keywords) {
    if (isAsciiOnly(kw)) {
      // Build a word-boundary regex once per keyword. The keyword set
      // is small + static so we don't bother caching the RegExp.
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`);
      if (re.test(label)) return true;
    } else {
      if (label.includes(kw)) return true;
    }
  }
  return false;
}

function isAsciiOnly(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferFieldRoles(fields: DetectedFormField[]): {
  nameField: string | null;
  emailField: string | null;
  subjectField: string | null;
  messageField: string | null;
  companyField: string | null;
  phoneField: string | null;
} {
  let nameField: string | null = null;
  let emailField: string | null = null;
  let subjectField: string | null = null;
  let messageField: string | null = null;
  let companyField: string | null = null;
  let phoneField: string | null = null;

  for (const f of fields) {
    const n = f.name.toLowerCase();
    const ac = (f.autocomplete ?? '').toLowerCase();
    const lbl = (f.label ?? '').toLowerCase();

    // autocomplete is the strongest signal when present (HTML5 spec).
    // Universal across locales — autocomplete tokens are spec-defined
    // English regardless of UI language.
    if (!emailField && (ac === 'email' || f.type === 'email')) emailField = f.name;
    if (
      !nameField &&
      (ac === 'name' ||
        ac === 'given-name' ||
        ac === 'family-name' ||
        ac === 'additional-name')
    )
      nameField = f.name;
    if (!phoneField && (ac === 'tel' || f.type === 'tel')) phoneField = f.name;
    if (!companyField && ac === 'organization') companyField = f.name;

    // English `name=` attribute patterns — devs use English names
    // even on non-English forms, so these match across all locales.
    if (!nameField && NAME_PATTERNS.test(n)) nameField = f.name;
    if (!emailField && EMAIL_PATTERNS.test(n)) emailField = f.name;
    if (!subjectField && SUBJECT_PATTERNS.test(n)) subjectField = f.name;
    if (
      !messageField &&
      (f.type === 'textarea' || MESSAGE_PATTERNS.test(n))
    )
      messageField = f.name;
    if (!companyField && COMPANY_PATTERNS.test(n)) companyField = f.name;
    if (!phoneField && PHONE_PATTERNS.test(n)) phoneField = f.name;

    // Multilingual label substring match — covers forms where the
    // `name=` attribute is non-English (less common but exists,
    // especially on legacy Japanese / Chinese / Korean corporate
    // sites) AND forms where the `name=` is opaque (`field_47`)
    // and the label is the only role signal.
    if (!nameField && labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.name))
      nameField = f.name;
    if (!emailField && labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.email))
      emailField = f.name;
    if (
      !subjectField &&
      labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.subject)
    )
      subjectField = f.name;
    if (
      !messageField &&
      labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.message)
    )
      messageField = f.name;
    if (
      !companyField &&
      labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.company)
    )
      companyField = f.name;
    if (!phoneField && labelMatchesAny(lbl, MULTILINGUAL_LABEL_KEYWORDS.phone))
      phoneField = f.name;
  }

  return {
    nameField,
    emailField,
    subjectField,
    messageField,
    companyField,
    phoneField,
  };
}
