'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { acknowledgeSignal } from '@procur/catalog';
import { requireCompany } from '@procur/auth';

const FormSchema = z.object({ id: z.string().min(1) });

export async function acknowledgeSignalAction(
  formData: FormData,
): Promise<void> {
  const { user } = await requireCompany();
  const parsed = FormSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  await acknowledgeSignal(parsed.data.id, user.id);
  revalidatePath('/signals');
}
