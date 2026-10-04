'use client';

import { useEffect, useState } from 'react';
import { appPath } from '@/lib/client/paths';
import { describeAccess } from '@/lib/client/session';

/**
 * Entry point — static-hosting version of the old server redirector.
 * Sends each state to the right place: signed out -> login, unactivated
 * account -> explanation page, active -> dashboard.
 */
export default function RootPage() {
  const [message, setMessage] = useState('جارٍ التحقق من الجلسة…');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await describeAccess();
        if (cancelled) return;
        switch (access.state) {
          case 'active':
            window.location.replace(appPath('/dashboard'));
            return;
          case 'anonymous':
            window.location.replace(appPath('/login'));
            return;
          case 'no_profile':
            window.location.replace(appPath('/not-authorized?reason=no_profile'));
            return;
          case 'pending':
            window.location.replace(appPath('/not-authorized?reason=pending'));
            return;
          case 'disabled':
            window.location.replace(appPath('/not-authorized?reason=disabled'));
            return;
        }
      } catch {
        if (!cancelled) setMessage('تعذر التحقق من الجلسة. أعد تحميل الصفحة.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="login-shell">
      <section className="card login-card">
        <div className="logo">م</div>
        <p>{message}</p>
      </section>
    </main>
  );
}
