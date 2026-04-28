import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function EntitiesLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Entity profile">{children}</AppShell>;
}
