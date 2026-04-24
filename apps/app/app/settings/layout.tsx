import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Company profile">{children}</AppShell>;
}
