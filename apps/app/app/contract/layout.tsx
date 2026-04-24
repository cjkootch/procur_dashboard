import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function ContractLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Contract">{children}</AppShell>;
}
