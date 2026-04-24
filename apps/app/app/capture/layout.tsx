import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function CaptureLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Capture">{children}</AppShell>;
}
