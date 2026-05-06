import { eq } from 'drizzle-orm';
import { companies, db } from '@procur/db';
import { requireCompany } from '@procur/auth';
import { saveEmailSettingsAction } from './actions';
import { EmailSettingsForm } from './EmailSettingsForm';

export const dynamic = 'force-dynamic';

/**
 * Per-company email defaults applied to every approved email.send.
 * Read by packages/ai/src/executors/email-send.ts at dispatch time.
 */
export default async function EmailSettingsPage() {
  const { company } = await requireCompany();
  const rows = await db
    .select({
      displayName: companies.emailSenderDisplayName,
      alwaysCc: companies.emailAlwaysCc,
      signatureHtml: companies.emailSignatureHtml,
      signatureText: companies.emailSignatureText,
      updatedAt: companies.updatedAt,
    })
    .from(companies)
    .where(eq(companies.id, company.id))
    .limit(1);
  const settings = rows[0] ?? null;
  const initialAlwaysCc = ((settings?.alwaysCc as string[] | null) ?? []).join('\n');

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Email settings</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Decorations applied to every approved <code>email.send</code> action.
          Recipients see whatever you set here on top of the workspace&apos;s
          verified domain.
        </p>
        {settings?.updatedAt && (
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Last saved{' '}
            <time dateTime={settings.updatedAt.toISOString()}>
              {settings.updatedAt.toLocaleString()}
            </time>
          </p>
        )}
      </header>

      <EmailSettingsForm
        action={saveEmailSettingsAction}
        initial={{
          displayName: settings?.displayName ?? '',
          alwaysCc: initialAlwaysCc,
          signatureHtml: settings?.signatureHtml ?? '',
          signatureText: settings?.signatureText ?? '',
        }}
      />
    </div>
  );
}
