'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/auth-gate';
import SettingsClient from '@/components/settings-client';
import { fetchAppearance } from '@/lib/client/settings';
import { isAdmin } from '@/lib/rbac';
import { appPath } from '@/lib/client/paths';
import type { AppearanceSettings } from '@/lib/appearance';

/**
 * إعدادات تنسيق الموقع — manager only (static-hosting version: the
 * appearance document is read through RLS; saving is admin-RLS-guarded).
 */
export default function SettingsPage() {
  const session = useSession();
  const router = useRouter();
  const [appearance, setAppearance] = useState<AppearanceSettings | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    if (!session) return;
    if (!isAdmin(session.profile)) {
      router.replace(appPath('/not-authorized?reason=settings'));
      setRefused(true);
      return;
    }

    let cancelled = false;
    (async () => {
      const settings = await fetchAppearance();
      if (!cancelled) setAppearance(settings);
    })();

    return () => {
      cancelled = true;
    };
  }, [session, router]);

  if (!session || refused) return null;

  return appearance === null ? (
    <section className="card"><div className="empty">جارٍ تحميل الإعدادات…</div></section>
  ) : (
    <SettingsClient initial={appearance} viewer={session.profile} />
  );
}
