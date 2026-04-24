import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function SearchLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Search">{children}</AppShell>;
}
