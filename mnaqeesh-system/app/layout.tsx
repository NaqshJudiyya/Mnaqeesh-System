import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'مناقيش — نظام إدارة المنشورات المحفوظة',
  description: 'نظام مركزي يجمع منشورات فيسبوك التي يحفظها الفريق عبر إضافة Facebook Post Saver.',
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
