import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function MarketPlaybooksLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
