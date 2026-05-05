import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function DealStructuresLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Deal structures">{children}</AppShell>;
}
