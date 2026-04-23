import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Procur — Win government contracts in emerging markets',
  description:
    'Procur is the AI-native platform for discovering, pursuing, and winning government contracts across the Caribbean, Latin America, and Africa.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
