import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Procur Discover — Government tenders across emerging markets',
  description:
    'Search and browse thousands of active government tenders from the Caribbean, Latin America, and Africa.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
