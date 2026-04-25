'use client';

import { ErrorBoundary } from '../../../components/errors/ErrorBoundary';

export default function ProposalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} surface="this proposal" />;
}
