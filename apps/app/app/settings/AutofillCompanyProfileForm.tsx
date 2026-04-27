'use client';

import { useActionState } from 'react';
import { Button, Input } from '@procur/ui';
import {
  autofillCompanyProfileAction,
  type AutofillState,
} from './actions';

export function AutofillCompanyProfileForm({
  defaultUrl,
}: {
  defaultUrl: string;
}) {
  const [state, action, pending] = useActionState<AutofillState, FormData>(
    autofillCompanyProfileAction,
    null,
  );

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Input
        name="websiteUrl"
        defaultValue={defaultUrl}
        placeholder="https://your-company.com"
        className="w-72"
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Reading…' : 'Autofill with AI'}
      </Button>
      {state && state.ok === false && (
        <p
          role="alert"
          className="basis-full text-xs text-red-700"
        >
          {state.error}
        </p>
      )}
      {state && state.ok === true && (
        <p className="basis-full text-xs text-emerald-700">
          Done — fields below are updated.
        </p>
      )}
    </form>
  );
}
