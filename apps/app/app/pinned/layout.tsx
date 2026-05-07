import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function PinnedLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
