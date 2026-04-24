import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function AlertsLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Alerts">{children}</AppShell>;
}
