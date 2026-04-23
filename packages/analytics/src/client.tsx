'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';
import { useEffect, type ReactNode } from 'react';

type Props = {
  apiKey: string | undefined;
  apiHost: string | undefined;
  children: ReactNode;
};

export function PostHogProvider({ apiKey, apiHost, children }: Props) {
  useEffect(() => {
    if (!apiKey || posthog.__loaded) return;
    posthog.init(apiKey, {
      api_host: apiHost ?? 'https://us.i.posthog.com',
      capture_pageview: 'history_change',
      capture_pageleave: true,
      person_profiles: 'identified_only',
    });
  }, [apiKey, apiHost]);

  if (!apiKey) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
