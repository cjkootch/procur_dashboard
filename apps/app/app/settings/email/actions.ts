'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { companies, db } from '@procur/db';
import { requireCompany } from '@procur/auth';

const FormSchema = z.object({
  displayName: z.string().max(120).optional(),
  alwaysCc: z.string().max(2000).optional(),
  signatureHtml: z.string().max(20_000).optional(),
  signatureText: z.string().max(8_000).optional(),
});

/**
 * Save per-company email defaults (display name, always-CC, signatures).
 * Read by `applyEmailSend` at dispatch time to decorate every approved
 * email.send action.
 */
export async function saveEmailSettingsAction(formData: FormData): Promise<void> {
  const { company } = await requireCompany();
  const parsed = FormSchema.safeParse({
    displayName: formData.get('displayName')?.toString() ?? '',
    alwaysCc: formData.get('alwaysCc')?.toString() ?? '',
    signatureHtml: formData.get('signatureHtml')?.toString() ?? '',
    signatureText: formData.get('signatureText')?.toString() ?? '',
  });
  if (!parsed.success) return;

  const ccArray = (parsed.data.alwaysCc ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5);

  await db
    .update(companies)
    .set({
      emailSenderDisplayName: parsed.data.displayName?.trim() || null,
      emailAlwaysCc: ccArray,
      emailSignatureHtml: parsed.data.signatureHtml?.trim() || null,
      emailSignatureText: parsed.data.signatureText?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, company.id));

  revalidatePath('/settings/email');
}
