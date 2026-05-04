import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

/** Wraps the crude grades catalog (`/crudes`) and detail
 *  (`/crudes/[slug]`) pages in the authenticated app shell. The pages
 *  themselves render their own headers (the index page uses a
 *  custom h1, the detail page uses a breadcrumb), so we pass an
 *  empty title to opt out of AppShell's auto-PageHeader. */
export default function CrudesLayout({ children }: { children: ReactNode }) {
  return <AppShell title="">{children}</AppShell>;
}
