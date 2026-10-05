'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Tab = { href: string; label: string; exact?: boolean };

/**
 * Dashboard navigation.
 *
 * Rendered client-side so the current section can be highlighted; the
 * manager-only tabs are only ever passed in for a manager, so editors and
 * translators have no route into the member list or the audit log.
 */
export default function DashboardNav({ isManager }: { isManager: boolean }) {
  const pathname = usePathname().replace(/\/+$/, '') || '/';

  const tabs: Tab[] = [
    { href: '/dashboard', label: 'المنشورات', exact: true },
    ...(isManager
      ? [
          { href: '/dashboard/members', label: 'الأعضاء والصلاحيات' },
          { href: '/dashboard/activity', label: 'سجل النشاط' },
          { href: '/dashboard/settings', label: 'الإعدادات' }
        ]
      : [])
  ];

  const isActive = (tab: Tab): boolean => {
    if (tab.exact) return pathname === tab.href || pathname.startsWith('/dashboard/posts');
    return pathname === tab.href || pathname.startsWith(tab.href + '/');
  };

  return (
    <nav className="tabs">
      {tabs.map((tab) => (
        <Link key={tab.href} className={`tab ${isActive(tab) ? 'active' : ''}`} href={tab.href}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
