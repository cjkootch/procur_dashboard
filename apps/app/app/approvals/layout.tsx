import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function ApprovalsLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
