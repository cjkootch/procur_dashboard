import Link from 'next/link';
import { cookies } from 'next/headers';
import { requireCompany } from '@procur/auth';
import {
  listWordAddinTokensForUser,
  WORD_ADDIN_FLASH_COOKIE,
} from '../../../lib/word-addin-tokens';
import {
  mintWordAddinTokenAction,
  revokeWordAddinTokenAction,
} from './actions';

export const dynamic = 'force-dynamic';

const ADDIN_BASE = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app').replace(/\/$/, '');
const MANIFEST_URL = `${ADDIN_BASE}/word-addin/manifest.xml`;
const TASKPANE_URL = `${ADDIN_BASE}/word-addin/taskpane.html`;

export default async function WordAddinSettingsPage() {
  const { user } = await requireCompany();
  const tokens = await listWordAddinTokensForUser(user.id);

  // One-shot flash: read the freshly-minted token if the redirect from
  // the mint action just happened. Cookie auto-expires in 60s and we
  // can't delete it from a server component, so the user has 60s to
  // copy before it disappears on its own.
  const c = await cookies();
  const flashToken = c.get(WORD_ADDIN_FLASH_COOKIE)?.value ?? null;

  const activeTokens = tokens.filter((t) => !t.revokedAt);
  const revokedTokens = tokens.filter((t) => t.revokedAt);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Word add-in</h1>
        <p className="mt-1 text-sm text-[color:var(--color-muted-foreground)]">
          Draft proposal sections directly from inside Microsoft Word using your Procur
          capture data, RFP requirements, and reusable content library.
        </p>
      </header>

      {flashToken && <FreshTokenCard token={flashToken} />}

      <section className="mb-8 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
        <h2 className="text-sm font-semibold">Create an access token</h2>
        <p className="mt-1 mb-3 text-xs text-[color:var(--color-muted-foreground)]">
          Tokens are tied to your account. Create one per device — revoke any time.
          Tokens stay valid until you revoke them.
        </p>
        <form
          action={mintWordAddinTokenAction}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
              Label
            </span>
            <input
              name="label"
              defaultValue="Word add-in"
              maxLength={80}
              className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm w-64"
            />
          </label>
          <button
            type="submit"
            className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
          >
            Create token
          </button>
        </form>
      </section>

      <InstallInstructions />

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">Active tokens ({activeTokens.length})</h2>
        {activeTokens.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-4 text-center text-xs text-[color:var(--color-muted-foreground)]">
            No active tokens.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
            {activeTokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{t.label}</p>
                  <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                    <span className="font-mono">prc_word_{t.tokenPrefix}…</span> · created{' '}
                    {fmtDate(t.createdAt)}
                    {t.lastUsedAt
                      ? ` · last used ${fmtDate(t.lastUsedAt)}`
                      : ' · not yet used'}
                  </p>
                </div>
                <form action={revokeWordAddinTokenAction}>
                  <input type="hidden" name="tokenId" value={t.id} />
                  <button
                    type="submit"
                    className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                  >
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revokedTokens.length > 0 && (
        <details className="mb-8">
          <summary className="cursor-pointer text-xs text-[color:var(--color-muted-foreground)]">
            Revoked tokens ({revokedTokens.length})
          </summary>
          <ul className="mt-2 divide-y divide-[color:var(--color-border)] rounded-[var(--radius-md)] border border-[color:var(--color-border)]">
            {revokedTokens.map((t) => (
              <li key={t.id} className="px-4 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                <span className="font-mono">prc_word_{t.tokenPrefix}…</span> · {t.label} ·
                revoked {t.revokedAt ? fmtDate(t.revokedAt) : '—'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FreshTokenCard({ token }: { token: string }) {
  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-emerald-300 bg-emerald-50/50 p-5">
      <h2 className="text-sm font-semibold text-emerald-900">Token created</h2>
      <p className="mt-1 mb-3 text-xs text-emerald-900/80">
        Copy this token now — it will never be shown again. Paste it into the Procur
        task pane in Word to pair this device.
      </p>
      <div className="rounded-[var(--radius-sm)] bg-white border border-emerald-300 px-3 py-2 font-mono text-xs break-all">
        {token}
      </div>
      <p className="mt-2 text-[11px] text-emerald-900/70">
        This banner disappears in 60 seconds.
      </p>
    </section>
  );
}

function InstallInstructions() {
  return (
    <section className="mb-8 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5">
      <h2 className="text-sm font-semibold">Install in Word</h2>
      <p className="mt-1 mb-3 text-xs text-[color:var(--color-muted-foreground)]">
        Sideload the manifest in Word — same flow on Mac, Windows, and Word for the web.
      </p>
      <ol className="space-y-2 text-sm">
        <li>
          <span className="font-medium">1.</span> Download the manifest:{' '}
          <a
            href={MANIFEST_URL}
            className="text-[color:var(--color-foreground)] underline"
            download
          >
            {MANIFEST_URL}
          </a>
        </li>
        <li>
          <span className="font-medium">2.</span> In Word, open <em>Insert → My Add-ins
          → Upload My Add-in</em> and pick the manifest.
        </li>
        <li>
          <span className="font-medium">3.</span> A new <strong>Procur</strong> button
          appears on the Home tab. Click it to open the task pane.
        </li>
        <li>
          <span className="font-medium">4.</span> Paste a token (above) into the pane and
          press <em>Pair</em>.
        </li>
      </ol>
      <p className="mt-3 text-[11px] text-[color:var(--color-muted-foreground)]">
        Task pane URL (for centralized deployment via Microsoft 365 admin):{' '}
        <span className="font-mono">{TASKPANE_URL}</span>
      </p>
      <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
        For full instructions and platform-specific notes, see{' '}
        <Link
          href="https://learn.microsoft.com/en-us/office/dev/add-ins/testing/test-debug-office-add-ins"
          className="underline"
          target="_blank"
        >
          Microsoft&rsquo;s sideload guide
        </Link>
        .
      </p>
    </section>
  );
}

function fmtDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
