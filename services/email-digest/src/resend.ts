import { Resend } from 'resend';
import { render } from '@react-email/render';
import type { ReactElement } from 'react';

let cached: Resend | null = null;

function getResend(): Resend {
  if (!cached) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set');
    }
    cached = new Resend(process.env.RESEND_API_KEY);
  }
  return cached;
}

export const FROM = 'Procur <hey@hey.procur.app>';
export const REPLY_TO = 'hello@procur.app';

export type SendEmailInput = {
  to: string;
  subject: string;
  template: ReactElement;
  tags?: Array<{ name: string; value: string }>;
  idempotencyKey?: string;
};

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const [html, text] = await Promise.all([
    render(input.template),
    render(input.template, { plainText: true }),
  ]);

  const resend = getResend();
  const { data, error } = await resend.emails.send(
    {
      from: FROM,
      to: input.to,
      replyTo: REPLY_TO,
      subject: input.subject,
      html,
      text,
      tags: input.tags,
    },
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
  );

  if (error) {
    throw new Error(`Resend error: ${error.name ?? ''} ${error.message ?? JSON.stringify(error)}`);
  }
  if (!data) throw new Error('Resend returned no data');
  return { id: data.id };
}
