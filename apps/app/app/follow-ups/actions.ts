'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireCompany } from '@procur/auth';
import { completeFollowUp } from '@procur/catalog';

const FormSchema = z.object({ id: z.string().min(1) });

export async function completeFollowUpAction(
  formData: FormData,
): Promise<void> {
  await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  await completeFollowUp(parsed.data.id);
  revalidatePath('/follow-ups');
}
