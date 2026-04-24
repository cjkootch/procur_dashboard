import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function LibraryLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Content library">{children}</AppShell>;
}
