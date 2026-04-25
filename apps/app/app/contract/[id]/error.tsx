'use client';

import { ErrorBoundary } from '../../../components/errors/ErrorBoundary';

export default function ContractDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} surface="this contract" />;
}
