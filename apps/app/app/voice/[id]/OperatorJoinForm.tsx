'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  initialJoinConferenceState,
  type JoinConferenceState,
} from './actions';

interface OperatorJoinFormProps {
  approvalId: string;
  conferenceRoom: string;
  action: (
    prev: JoinConferenceState,
    formData: FormData,
  ) => Promise<JoinConferenceState>;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const PHONE_LOCAL_KEY = 'procur:operator-phone';

/**
 * Operator-join form. Asks for the phone we should dial, persists
 * the value in localStorage so subsequent joins prefill, and POSTs
 * to the server action which uses Twilio to dial that number into
 * the conference.
 */
export function OperatorJoinForm({
  approvalId,
  conferenceRoom,
  action,
}: OperatorJoinFormProps) {
  const [phone, setPhone] = useState('');
  const [state, formAction] = useActionState(
    action,
    initialJoinConferenceState,
  );

  // Prefill from localStorage on mount; remember on success.
  useEffect(() => {
    const stored =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(PHONE_LOCAL_KEY)
        : null;
    if (stored) setPhone(stored);
  }, []);

  useEffect(() => {
    if (state.status === 'success' && phone) {
      try {
        window.localStorage.setItem(PHONE_LOCAL_KEY, phone);
      } catch {
        // Quota / private mode — non-critical; just skip persisting.
      }
    }
  }, [state.status, phone]);

  const phoneValid = E164.test(phone);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="approvalId" value={approvalId} />

      {state.status === 'success' && (
        <div
          role="status"
          className="rounded-[var(--radius-md)] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          <strong className="font-semibold">Calling you now.</strong>{' '}
          {state.message} Twilio CallSid:{' '}
          <span className="font-mono">{state.callSid}</span>
        </div>
      )}
      {state.status === 'error' && (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <strong className="font-semibold">Couldn&apos;t dial:</strong>{' '}
          {state.message}
        </div>
      )}

      <div>
        <label
          htmlFor="operatorNumber"
          className="block text-xs font-medium text-[color:var(--color-muted-foreground)]"
        >
          Your phone number
        </label>
        <input
          id="operatorNumber"
          name="operatorNumber"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          placeholder="+18324927169"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          className="mt-2 block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 font-mono text-sm"
        />
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          E.164 format: country code + number, no spaces or dashes.
          Saved in this browser so future joins prefill.
        </p>
        {phone && !phoneValid && (
          <p className="mt-1 text-xs text-red-700">
            Doesn&apos;t look like E.164 — example:{' '}
            <span className="font-mono">+18324927169</span>
          </p>
        )}
      </div>

      <p className="text-xs text-[color:var(--color-muted-foreground)]">
        On submit, Twilio dials your number from{' '}
        <span className="font-mono">TWILIO_PHONE_NUMBER</span>. When you
        answer, you join the conference room{' '}
        <span className="font-mono">{conferenceRoom}</span> with the
        recipient.
      </p>

      <SubmitButton disabled={!phoneValid} />
    </form>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="w-full rounded-[var(--radius-md)] bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Dialing…' : 'Call my phone to join'}
    </button>
  );
}
