import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function PricerLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Pricer">{children}</AppShell>;
}
