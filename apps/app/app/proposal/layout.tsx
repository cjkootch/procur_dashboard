import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

export default function ProposalLayout({ children }: { children: ReactNode }) {
  return <AppShell title="Proposal">{children}</AppShell>;
}
