import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function SuppliersLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Supplier graph">{children}</AppShell>;
}
