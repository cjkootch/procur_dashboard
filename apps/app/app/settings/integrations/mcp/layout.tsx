import type { ReactNode } from 'react';
import { AppShell } from '../../../../components/shell/AppShell';

export default function McpIntegrationLayout({ children }: { children: ReactNode }) {
  return <AppShell title="">{children}</AppShell>;
}
