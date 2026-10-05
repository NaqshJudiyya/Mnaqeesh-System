import type { Metadata } from 'next';
import ThemeBoot from '@/components/theme-boot';
import './globals.css';

export const metadata: Metadata = {
  title: 'مناقيش — نظام إدارة المنشورات المحفوظة',
  description: 'نظام مركزي يجمع منشورات فيسبوك التي يحفظها الفريق عبر إضافة Facebook Post Saver.',
  robots: { index: false, follow: false }
};

/**
 * Static shell — no server-side data access, because the app exports to
 * plain files for GitHub Pages / Firebase Hosting. The theme vars come
 * from ThemeBoot (client) and the stylesheet defaults.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <ThemeBoot />
        {children}
      </body>
    </html>
  );
}
