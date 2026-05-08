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
    const hasMessageField = fields.some(
      (f) =>
        f.type === 'textarea' ||
        /message|comment|inquiry|enquiry|details|notes/i.test(f.name) ||
        (f.label != null &&
          /message|comment|inquiry|enquiry|details|notes/i.test(f.label)),
    );
    if (!hasMessageField) return;

    const action = resolveActionUrl(
      $form.attr('action') ?? '',
      pageBaseUrl,
    );
    const method = ($form.attr('method') ?? 'get').toLowerCase();

    let submitMethod: DetectedFormEndpoint['submitMethod'] = 'unknown';
    if (method === 'post') {
      submitMethod = 'http_post';
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

const NAME_PATTERNS = /^(name|fname|first_?name|full_?name|your_?name|contact_?name)$/i;
const EMAIL_PATTERNS = /^(email|e_?mail|email_?address|your_?email|contact_?email)$/i;
const SUBJECT_PATTERNS = /^(subject|topic|reason|inquiry_?subject)$/i;
const MESSAGE_PATTERNS = /^(message|comments?|inquiry|enquiry|details|body|description|notes)$/i;
const COMPANY_PATTERNS = /^(company|company_?name|organization|organisation|business|firm)$/i;
const PHONE_PATTERNS = /^(phone|tel|telephone|mobile|cell|contact_?phone)$/i;

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

    // autocomplete is the strongest signal when present (HTML5 spec)
    if (!emailField && (ac === 'email' || f.type === 'email')) emailField = f.name;
    if (!nameField && (ac === 'name' || ac === 'given-name')) nameField = f.name;
    if (!phoneField && (ac === 'tel' || f.type === 'tel')) phoneField = f.name;
    if (!companyField && ac === 'organization') companyField = f.name;

    // name + label heuristics
    if (!nameField && (NAME_PATTERNS.test(n) || /\bname\b/.test(lbl)))
      nameField = f.name;
    if (!emailField && (EMAIL_PATTERNS.test(n) || /\bemail\b/.test(lbl)))
      emailField = f.name;
    if (!subjectField && (SUBJECT_PATTERNS.test(n) || /\bsubject\b/.test(lbl)))
      subjectField = f.name;
    if (
      !messageField &&
      (f.type === 'textarea' ||
        MESSAGE_PATTERNS.test(n) ||
        /\b(message|comment|inquiry|enquiry|notes)\b/.test(lbl))
    )
      messageField = f.name;
    if (
      !companyField &&
      (COMPANY_PATTERNS.test(n) || /\b(company|organi[sz]ation)\b/.test(lbl))
    )
      companyField = f.name;
    if (!phoneField && (PHONE_PATTERNS.test(n) || /\b(phone|telephone)\b/.test(lbl)))
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
