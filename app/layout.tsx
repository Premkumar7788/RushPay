import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RushPay',
  description: 'Zero-bandwidth campus micropayments: offline signed tokens verified at the counter.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
