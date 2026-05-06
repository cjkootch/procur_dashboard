'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  initialSaveEmailSettingsState,
  type SaveEmailSettingsState,
} from './actions';

interface EmailSettingsFormProps {
  action: (
    prev: SaveEmailSettingsState,
    formData: FormData,
  ) => Promise<SaveEmailSettingsState>;
  initial: {
    displayName: string;
    alwaysCc: string;
    signatureHtml: string;
    signatureText: string;
  };
}

/**
 * Form for /settings/email. Mirrors vex's email-defaults UX with a
 * live HTML signature preview rendered from the textarea on the
 * left. The plain-text signature on the right is appended after an
 * RFC-standard "-- " delimiter so accessibility tools and plain-text
 * readers see it.
 */
export function EmailSettingsForm({ action, initial }: EmailSettingsFormProps) {
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [alwaysCc, setAlwaysCc] = useState(initial.alwaysCc);
  const [signatureHtml, setSignatureHtml] = useState(initial.signatureHtml);
  const [signatureText, setSignatureText] = useState(initial.signatureText);

  const [state, formAction] = useActionState(
    action,
    initialSaveEmailSettingsState,
  );

  return (
    <form action={formAction} className="space-y-8">
      <SaveBanner state={state} />

      <section>
        <h2 className="text-base font-semibold">Sender display name</h2>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Decorates the outbound <code>From</code> header for every approved{' '}
          <code>email.send</code> action. Recipients see this name; the technical
          address stays on the workspace&apos;s verified domain. Leave blank to
          send with the address alone.
        </p>
        <input
          name="displayName"
          type="text"
          maxLength={120}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Vector Trade Capital"
          className="mt-3 block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm"
        />
      </section>

      <section>
        <h2 className="text-base font-semibold">Always-CC addresses</h2>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          CC&apos;d on every outbound <code>email.send</code>. Recipients see them.
          Typical use: copy your own work address so threads land in your inbox
          and stay searchable. One address per line, max 5.
        </p>
        <textarea
          name="alwaysCc"
          maxLength={2000}
          rows={4}
          value={alwaysCc}
          onChange={(e) => setAlwaysCc(e.target.value)}
          placeholder="cole@vectortradecapital.com"
          className="mt-3 block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-xs"
        />
      </section>

      <section>
        <h2 className="text-base font-semibold">Email signature</h2>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Appended to every outbound email sent through an approved{' '}
          <code>email.send</code> action. Plain text falls back to HTML-stripped
          when not provided. Leave both blank to use the auto-generated default
          (workspace name only).
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-[color:var(--color-muted-foreground)]">
              HTML signature
            </label>
            <textarea
              name="signatureHtml"
              maxLength={20_000}
              rows={10}
              value={signatureHtml}
              onChange={(e) => setSignatureHtml(e.target.value)}
              placeholder='<table cellpadding="0" cellspacing="0">…</table>'
              className="mt-2 block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
              Raw HTML. Inline styles only — Gmail and Outlook strip{' '}
              <code>&lt;style&gt;</code> blocks.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[color:var(--color-muted-foreground)]">
              Plain-text signature
            </label>
            <textarea
              name="signatureText"
              maxLength={8_000}
              rows={10}
              value={signatureText}
              onChange={(e) => setSignatureText(e.target.value)}
              placeholder="Trade Desk\nVector Trade Capital"
              className="mt-2 block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
              Rendered by plain-text email clients and accessibility tools.
              Appended after an RFC-standard &quot;-- &quot; delimiter.
            </p>
          </div>
        </div>

        {signatureHtml.trim() && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-[color:var(--color-muted-foreground)]">
              HTML preview
            </p>
            <div
              className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-white p-4 text-black"
              // The HTML is operator-authored and stored on their own
              // company row; not user-generated content from third
              // parties. Render as-is so the preview matches the
              // outbound email.
              dangerouslySetInnerHTML={{ __html: signatureHtml }}
            />
          </div>
        )}
      </section>

      <div className="flex items-center justify-end gap-3">
        <InlineStatus state={state} />
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)] disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save email settings'}
    </button>
  );
}

/**
 * Inline status next to the submit button — fades the success
 * confirmation after 4s so it doesn't linger past the moment the
 * user moved on. Errors stay visible until the next save attempt.
 */
function InlineStatus({ state }: { state: SaveEmailSettingsState }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (state.status === 'success') {
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(t);
    }
    if (state.status === 'error') {
      setVisible(true);
    }
  }, [state]);

  if (!visible || state.status === 'idle') return null;

  return (
    <span
      className={
        state.status === 'success'
          ? 'text-xs font-medium text-emerald-600'
          : 'text-xs font-medium text-red-600'
      }
    >
      {state.status === 'success' ? '✓ Saved' : `✗ ${state.message}`}
    </span>
  );
}

/**
 * Top-of-form banner — louder confirmation that survives even when
 * the user's cursor is on the submit button when the action resolves
 * (the save button at the bottom can be the only thing in viewport
 * on tall forms).
 */
function SaveBanner({ state }: { state: SaveEmailSettingsState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'success') {
    return (
      <div
        role="status"
        className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
      >
        <strong className="font-semibold">Saved.</strong> {state.message} New
        defaults apply to the next approved <code>email.send</code>.
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <strong className="font-semibold">Couldn&apos;t save:</strong>{' '}
      {state.message}
    </div>
  );
}
