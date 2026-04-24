import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function InsightsLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Insights">{children}</AppShell>;
}
