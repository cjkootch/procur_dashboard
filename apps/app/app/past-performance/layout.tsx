import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function PastPerformanceLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Past performance">{children}</AppShell>;
}
