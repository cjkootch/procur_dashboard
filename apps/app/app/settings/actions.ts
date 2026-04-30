'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { companies, db } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { extractCompanyProfile, meter, MODELS } from '@procur/ai';

function str(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function arr(formData: FormData, key: string): string[] | null {
  const all = formData.getAll(key).map((v) => String(v).trim()).filter(Boolean);
  if (all.length > 1) return all;
  const single = str(formData, key);
  if (!single) return null;
  const parts = single.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function int(formData: FormData, key: string): number | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function decimal(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n.toString() : null;
}

/** Form input is a percent (5 = 5%); we store it as a decimal (0.05). */
function pctToDecimal(formData: FormData, key: string): string | null {
  const v = str(formData, key);
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? (n / 100).toString() : null;
}

export async function updateCompanyProfileAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();

  await db
    .update(companies)
    .set({
      name: str(formData, 'name') ?? company.name,
      websiteUrl: str(formData, 'websiteUrl'),
      country: str(formData, 'country'),
      industry: str(formData, 'industry'),
      yearFounded: int(formData, 'yearFounded'),
      employeeCount: int(formData, 'employeeCount'),
      annualRevenue: str(formData, 'annualRevenue'),
      capabilities: arr(formData, 'capabilities'),
      preferredJurisdictions: arr(formData, 'preferredJurisdictions'),
      preferredCategories: arr(formData, 'preferredCategories'),
      targetContractSizeMin: int(formData, 'targetContractSizeMin'),
      targetContractSizeMax: int(formData, 'targetContractSizeMax'),
      defaultSourcingRegion: str(formData, 'defaultSourcingRegion'),
      targetGrossMarginPct: pctToDecimal(formData, 'targetGrossMarginPct'),
      targetNetMarginPerUsg: decimal(formData, 'targetNetMarginPerUsg'),
      monthlyFixedOverheadUsdDefault: int(
        formData,
        'monthlyFixedOverheadUsdDefault',
      ),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, company.id));

  revalidatePath('/settings');
}

/**
 * Result type for the autofill action — we surface errors inline in
 * the form via `useActionState` instead of throwing, which would crash
 * into the page-level error boundary and hide the actual reason behind
 * a generic digest.
 */
export type AutofillState =
  | { ok: true }
  | { ok: false; error: string }
  | null;

/**
 * Fetches the user's company website, hands the text to Sonnet, and merges
 * the returned profile suggestions with the existing company row. Non-null
 * user-set fields are preserved; empty fields get populated. Capabilities
 * are de-duped by lower-case match.
 */
export async function autofillCompanyProfileAction(
  _prev: AutofillState,
  formData: FormData,
): Promise<AutofillState> {
  try {
    const { company } = await requireCompany();
    const inputUrl = str(formData, 'websiteUrl') ?? company.websiteUrl;
    if (!inputUrl) {
      return { ok: false, error: 'Add a website URL first.' };
    }

    const normalizedUrl = inputUrl.startsWith('http') ? inputUrl : `https://${inputUrl}`;

    let html = '';
    try {
      const res = await fetch(normalizedUrl, {
        headers: { 'user-agent': 'ProcurProfileBot/1.0 (+https://procur.app)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Couldn't fetch ${normalizedUrl} — server returned ${res.status}.`,
        };
      }
      const raw = await res.text();
      html = raw.slice(0, 200_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return {
        ok: false,
        error: `Couldn't reach ${normalizedUrl}. ${msg}`,
      };
    }

    const text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length < 200) {
      return {
        ok: false,
        error: 'The page returned too little readable text. If your site is JS-rendered, try a static About page URL.',
      };
    }

    let suggestion: Awaited<ReturnType<typeof extractCompanyProfile>>;
    try {
      suggestion = await extractCompanyProfile({
        websiteUrl: normalizedUrl,
        websiteText: text,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: `AI extraction failed: ${msg}` };
    }
    await meter({
      companyId: company.id,
      source: 'extract_company_profile',
      model: MODELS.sonnet,
      usage: suggestion.usage,
    });

    const existing = new Set(
      (company.capabilities ?? []).map((c) => c.toLowerCase()),
    );
    const mergedCapabilities = [
      ...(company.capabilities ?? []),
      ...suggestion.suggestedCapabilities.filter((c) => !existing.has(c.toLowerCase())),
    ];

    await db
      .update(companies)
      .set({
        websiteUrl: company.websiteUrl ?? normalizedUrl,
        industry: company.industry ?? suggestion.suggestedIndustry,
        yearFounded: company.yearFounded ?? suggestion.yearFoundedHint,
        employeeCount: company.employeeCount ?? suggestion.employeeCountHint,
        capabilities: mergedCapabilities.length > 0 ? mergedCapabilities : null,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, company.id));

    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    // Last-resort catch — keeps the page from crashing into the error
    // boundary even if something we didn't anticipate fails.
    const msg = err instanceof Error ? err.message : 'Unexpected error.';
    return { ok: false, error: msg };
  }
}
